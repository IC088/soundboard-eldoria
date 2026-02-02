const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Category-specific directories
const AUDIO_DIRS = {
  bgm: path.join(__dirname, 'audio', 'bgm'),
  ambience: path.join(__dirname, 'audio', 'ambience'),
  sfx: path.join(__dirname, 'audio', 'sfx')
};

// Ensure all audio directories exist
Object.values(AUDIO_DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// File size limits per category
const SIZE_LIMITS = {
  bgm: 500 * 1024 * 1024,      // 500MB - full soundtracks
  ambience: 500 * 1024 * 1024, // 500MB - long ambient loops
  sfx: 10 * 1024 * 1024        // 10MB - short sound bites
};

// Multer storage factory for each category
const createStorage = (category) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, AUDIO_DIRS[category]),
  filename: (req, file, cb) => {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${sanitized}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'];
  const ext = path.extname(file.originalname).toLowerCase();
  cb(null, allowed.includes(ext));
};

// Create upload handlers for each category
const uploads = {
  bgm: multer({ storage: createStorage('bgm'), fileFilter, limits: { fileSize: SIZE_LIMITS.bgm } }),
  ambience: multer({ storage: createStorage('ambience'), fileFilter, limits: { fileSize: SIZE_LIMITS.ambience } }),
  sfx: multer({ storage: createStorage('sfx'), fileFilter, limits: { fileSize: SIZE_LIMITS.sfx } })
};

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio/bgm', express.static(AUDIO_DIRS.bgm));
app.use('/audio/ambience', express.static(AUDIO_DIRS.ambience));
app.use('/audio/sfx', express.static(AUDIO_DIRS.sfx));
app.use(express.json());

// Serve player-volume-control.js specifically
app.get('/player-volume-control.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player-volume-control.js'));
});

// Current playback state
let playbackState = {
  bgm: { track: null, playing: false, volume: 0.5, currentTime: 0, loop: true },
  ambience: { track: null, playing: false, volume: 0.3, currentTime: 0, loop: true },
  sfx: [] // One-shot sounds
};

let connectedClients = { dm: null, players: new Set() };

// API Routes

// Get all tracks organized by category
app.get('/api/tracks', (req, res) => {
  try {
    const result = {};
    for (const [category, dir] of Object.entries(AUDIO_DIRS)) {
      result[category] = fs.readdirSync(dir)
        .filter(f => ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'].includes(path.extname(f).toLowerCase()))
        .map(f => {
          const stats = fs.statSync(path.join(dir, f));
          return {
            filename: f,
            name: f.replace(/^\d+-/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' '),
            size: stats.size,
            category,
            url: `/audio/${category}/${encodeURIComponent(f)}`
          };
        });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read tracks' });
  }
});

// Get size limits for UI display
app.get('/api/limits', (req, res) => {
  res.json({
    bgm: { limit: SIZE_LIMITS.bgm, label: '500MB' },
    ambience: { limit: SIZE_LIMITS.ambience, label: '500MB' },
    sfx: { limit: SIZE_LIMITS.sfx, label: '10MB' }
  });
});

// Category-specific upload endpoints
app.post('/api/upload/bgm', uploads.bgm.array('files', 20), (req, res) => {
  handleUpload(req, res, 'bgm');
});

app.post('/api/upload/ambience', uploads.ambience.array('files', 20), (req, res) => {
  handleUpload(req, res, 'ambience');
});

app.post('/api/upload/sfx', uploads.sfx.array('files', 20), (req, res) => {
  handleUpload(req, res, 'sfx');
});

function handleUpload(req, res, category) {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }
  const uploaded = req.files.map(f => ({
    filename: f.filename,
    name: f.originalname.replace(/\.[^.]+$/, ''),
    category,
    url: `/audio/${category}/${encodeURIComponent(f.filename)}`
  }));
  io.emit('tracks:updated');
  res.json({ success: true, files: uploaded });
}

// Error handler for file size limit
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const category = req.path.split('/').pop();
    const limitMB = SIZE_LIMITS[category] ? SIZE_LIMITS[category] / (1024 * 1024) : 'unknown';
    return res.status(413).json({ 
      error: `File too large. ${category.toUpperCase()} limit is ${limitMB}MB` 
    });
  }
  next(err);
});

app.delete('/api/tracks/:category/:filename', (req, res) => {
  const { category, filename } = req.params;
  if (!AUDIO_DIRS[category]) {
    return res.status(400).json({ error: 'Invalid category' });
  }
  const filepath = path.join(AUDIO_DIRS[category], filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    io.emit('tracks:updated');
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/api/state', (req, res) => {
  res.json(playbackState);
});

// Socket.IO for real-time sync
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('register', (role) => {
    socket.role = role;
    if (role === 'dm') {
      connectedClients.dm = socket.id;
    } else {
      connectedClients.players.add(socket.id);
    }
    
    // Calculate current playback positions for syncing
    const syncState = {
      bgm: { ...playbackState.bgm },
      ambience: { ...playbackState.ambience }
    };
    
    // Calculate elapsed time for BGM if playing
    if (playbackState.bgm.playing && playbackState.bgm.startTime) {
      const elapsed = (Date.now() - playbackState.bgm.startTime) / 1000;
      syncState.bgm.currentTime = (playbackState.bgm.currentTime || 0) + elapsed;
    }
    
    // Calculate elapsed time for Ambience if playing
    if (playbackState.ambience.playing && playbackState.ambience.startTime) {
      const elapsed = (Date.now() - playbackState.ambience.startTime) / 1000;
      syncState.ambience.currentTime = (playbackState.ambience.currentTime || 0) + elapsed;
    }
    
    // Send current state to new client with calculated positions
    socket.emit('state:sync', syncState);
    
    io.emit('clients:update', {
      dm: !!connectedClients.dm,
      players: connectedClients.players.size
    });
  });

  // BGM Controls
  socket.on('bgm:play', (data) => {
    playbackState.bgm = { ...playbackState.bgm, ...data, playing: true, startTime: Date.now() };
    io.emit('bgm:play', playbackState.bgm);
  });

  socket.on('bgm:pause', () => {
    playbackState.bgm.playing = false;
    io.emit('bgm:pause');
  });

  socket.on('bgm:stop', () => {
    playbackState.bgm = { track: null, playing: false, volume: playbackState.bgm.volume, currentTime: 0, loop: true };
    io.emit('bgm:stop');
  });

  socket.on('bgm:volume', (volume) => {
    playbackState.bgm.volume = volume;
    io.emit('bgm:volume', volume);
  });

  socket.on('bgm:seek', (time) => {
    playbackState.bgm.currentTime = time;
    playbackState.bgm.startTime = Date.now();
    io.emit('bgm:seek', time);
  });

  socket.on('bgm:loop', (loop) => {
    playbackState.bgm.loop = loop;
    io.emit('bgm:loop', loop);
  });

  // Update current time periodically (from DM)
  socket.on('bgm:time-update', (currentTime) => {
    playbackState.bgm.currentTime = currentTime;
    playbackState.bgm.startTime = Date.now();
  });

  // Ambience Controls
  socket.on('ambience:play', (data) => {
    playbackState.ambience = { ...playbackState.ambience, ...data, playing: true, startTime: Date.now() };
    io.emit('ambience:play', playbackState.ambience);
  });

  socket.on('ambience:pause', () => {
    playbackState.ambience.playing = false;
    io.emit('ambience:pause');
  });

  socket.on('ambience:stop', () => {
    playbackState.ambience = { track: null, playing: false, volume: playbackState.ambience.volume, currentTime: 0, loop: true };
    io.emit('ambience:stop');
  });

  socket.on('ambience:volume', (volume) => {
    playbackState.ambience.volume = volume;
    io.emit('ambience:volume', volume);
  });

  // Update current time periodically (from DM)
  socket.on('ambience:time-update', (currentTime) => {
    playbackState.ambience.currentTime = currentTime;
    playbackState.ambience.startTime = Date.now();
  });

  // SFX - one-shot sounds
  socket.on('sfx:play', (data) => {
    io.emit('sfx:play', data);
  });

  // Fade controls
  socket.on('fade:out', (data) => {
    io.emit('fade:out', data);
  });

  socket.on('fade:in', (data) => {
    io.emit('fade:in', data);
  });

  // Master controls
  socket.on('master:stop', () => {
    playbackState.bgm = { track: null, playing: false, volume: playbackState.bgm.volume, currentTime: 0, loop: true };
    playbackState.ambience = { track: null, playing: false, volume: playbackState.ambience.volume, currentTime: 0, loop: true };
    io.emit('master:stop');
  });

  // Player volume controls (client-side only, no state changes)
  // These events are just for logging/debugging - actual volume mixing happens client-side
  socket.on('player:volume:master', (volume) => {
    console.log(`Player ${socket.id} set master volume to ${volume}`);
    // No broadcast needed - this is local to the player
  });

  socket.on('player:volume:bgm', (volume) => {
    console.log(`Player ${socket.id} set BGM volume to ${volume}`);
    // No broadcast needed - this is local to the player
  });

  socket.on('player:volume:ambience', (volume) => {
    console.log(`Player ${socket.id} set ambience volume to ${volume}`);
    // No broadcast needed - this is local to the player
  });

  socket.on('player:volume:sfx', (volume) => {
    console.log(`Player ${socket.id} set SFX volume to ${volume}`);
    // No broadcast needed - this is local to the player
  });

  // Real-time sync system
  socket.on('sync:broadcast', (data) => {
    // DM broadcasts current playback position to all players
    if (socket.role === 'dm') {
      socket.broadcast.emit('sync:broadcast', data);
      console.log(`Sync broadcast from DM to ${connectedClients.players.size} players`);
    }
  });

  socket.on('sync:request', () => {
    // Player requests immediate sync from DM
    if (connectedClients.dm) {
      io.to(connectedClients.dm).emit('sync:request');
      console.log(`Player ${socket.id} requested sync from DM`);
    }
  });

  socket.on('disconnect', () => {
    if (socket.role === 'dm') {
      connectedClients.dm = null;
    } else {
      connectedClients.players.delete(socket.id);
    }
    io.emit('clients:update', {
      dm: !!connectedClients.dm,
      players: connectedClients.players.size
    });
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Soundboard server running on http://localhost:${PORT}`);
  console.log(`   DM View: http://localhost:${PORT}`);
  console.log(`   Player View: http://localhost:${PORT}/player.html`);
});