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
// Serve dice-box assets (3D dice WebGL library)
app.use('/assets/dice-box', express.static(path.join(__dirname, 'public', 'assets', 'dice-box')));
app.use(express.json());

// Serve player.js from root (sits alongside server.js)
app.get('/player.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'player.js'));
});

// Serve dice.js from root
app.get('/dice.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'dice.js'));
});

// Current playback state
// playbackStartedAt: server timestamp (ms) when play began at currentTime.
// duration: track length in seconds — used to wrap elapsed time on loop.
// Used to compute live elapsed position for late-joining players.
let playbackState = {
  bgm:      { track: null, playing: false, volume: 0.5, currentTime: 0, loop: true, duration: null, playbackStartedAt: null },
  ambience: { track: null, playing: false, volume: 0.3, currentTime: 0, loop: true, duration: null, playbackStartedAt: null },
  sfx: []
};

// Returns the live currentTime for a channel, accounting for elapsed wall-clock time since play started.
// For looping tracks, wraps elapsed time using modulo against track duration.
function getLiveCurrentTime(channel) {
  const ch = playbackState[channel];
  if (!ch.playing || ch.playbackStartedAt === null) return ch.currentTime;
  const elapsed = (Date.now() - ch.playbackStartedAt) / 1000;
  const raw = ch.currentTime + elapsed;
  // If looping and we know the duration, wrap the position so late joiners
  // land at the correct point in the current loop rather than past the end
  if (ch.loop && ch.duration && ch.duration > 0) {
    return raw % ch.duration;
  }
  return raw;
}

// Builds a state snapshot with live currentTime injected — safe to send to clients.
function getLiveState() {
  return {
    bgm:      { ...playbackState.bgm,      currentTime: getLiveCurrentTime('bgm') },
    ambience: { ...playbackState.ambience, currentTime: getLiveCurrentTime('ambience') }
  };
}

// ---------------------------------------------------------------------------
// Dice state — per-character roll history (session-scoped, in memory)
// ---------------------------------------------------------------------------

// rollHistory: Map of characterName -> Array of roll records
// Each record: { id, roller, label, pool, modifiers, total, dice, visibility,
//                degreeOfSuccess, dc, timestamp, isNat20, isNat1 }
const rollHistory = new Map();
const sessionFeed = []; // flat ordered list for the live feed (last 100 rolls)
const MAX_FEED    = 100;

function addToHistory(record) {
  const key = record.roller;
  if (!rollHistory.has(key)) rollHistory.set(key, []);
  rollHistory.get(key).unshift(record); // newest first
  if (rollHistory.get(key).length > 200) rollHistory.get(key).pop();

  sessionFeed.unshift(record);
  if (sessionFeed.length > MAX_FEED) sessionFeed.pop();
}

// Degree of success calculation per PF2e rules:
// nat20 upgrades result by one step, nat1 downgrades by one step
function calcDegreeOfSuccess(total, dc, isNat20, isNat1) {
  if (!dc) return null;
  const margin = total - dc;
  let degree; // 0=crit fail, 1=fail, 2=success, 3=crit success
  if      (margin >= 10)  degree = 3;
  else if (margin >= 0)   degree = 2;
  else if (margin >= -9)  degree = 1;
  else                    degree = 0;
  if (isNat20) degree = Math.min(3, degree + 1);
  if (isNat1)  degree = Math.max(0, degree - 1);
  return ['Critical failure', 'Failure', 'Success', 'Critical success'][degree];
}



// Per-player sync state: socketId -> { syncMode: 'LIVE'|'PAUSED', pausedAt: timestamp|null }
const playerSyncState = new Map();

function broadcastClientUpdate() {
  const playerList = [];
  playerSyncState.forEach((state, id) => {
    playerList.push({ id, name: state.name || id, syncMode: state.syncMode });
  });
  const pausedCount = playerList.filter(p => p.syncMode === 'PAUSED').length;
  io.emit('clients:update', {
    dm: !!connectedClients.dm,
    players: connectedClients.players.size,
    pausedCount,
    playerList
  });
}

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

app.get('/api/dice/history/:character', (req, res) => {
  const history = rollHistory.get(req.params.character) || [];
  res.json({ character: req.params.character, rolls: history });
});

app.get('/api/dice/feed', (req, res) => {
  res.json(sessionFeed);
});

// Socket.IO for real-time sync
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('register', (payload) => {
    // Accept both legacy 'player'/'dm' strings and new { role, name } objects
    const role = typeof payload === 'string' ? payload : payload.role;
    const name = typeof payload === 'object' && payload.name ? payload.name : null;

    socket.role = role;
    socket.playerName = name;

    if (role === 'dm') {
      connectedClients.dm = socket.id;
    } else {
      connectedClients.players.add(socket.id);
      playerSyncState.set(socket.id, { syncMode: 'LIVE', pausedAt: null, name: name || socket.id });
    }
    // Send live state (with computed currentTime) to new client
    socket.emit('state:sync', getLiveState());
    broadcastClientUpdate();
  });

  // BGM Controls
  socket.on('bgm:play', (data) => {
    playbackState.bgm = {
      ...playbackState.bgm,
      ...data,
      playing: true,
      playbackStartedAt: Date.now()   // clock starts now at data.currentTime
    };
    io.emit('bgm:play', playbackState.bgm);
    // Force paused players back to live on track change (dramatic reveals shouldn't be missable)
    playerSyncState.forEach((state, id) => {
      if (state.syncMode === 'PAUSED') {
        playerSyncState.set(id, { syncMode: 'LIVE', pausedAt: null });
        io.to(id).emit('player:force:rejoin', getLiveState());
      }
    });
    broadcastClientUpdate();
  });

  socket.on('bgm:pause', () => {
    playbackState.bgm.currentTime = getLiveCurrentTime('bgm');
    playbackState.bgm.playing = false;
    playbackState.bgm.playbackStartedAt = null;
    io.emit('bgm:pause');
  });

  socket.on('bgm:stop', () => {
    playbackState.bgm = { track: null, playing: false, volume: playbackState.bgm.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    io.emit('bgm:stop');
  });

  socket.on('bgm:volume', (volume) => {
    playbackState.bgm.volume = volume;
    io.emit('bgm:volume', volume);
  });

  socket.on('bgm:seek', (time) => {
    playbackState.bgm.currentTime = time;
    // Reset the clock reference so elapsed time is calculated from the new position
    if (playbackState.bgm.playing) playbackState.bgm.playbackStartedAt = Date.now();
    io.emit('bgm:seek', time);
  });

  socket.on('bgm:loop', (loop) => {
    playbackState.bgm.loop = loop;
    io.emit('bgm:loop', loop);
  });

  // Ambience Controls
  socket.on('ambience:play', (data) => {
    playbackState.ambience = {
      ...playbackState.ambience,
      ...data,
      playing: true,
      playbackStartedAt: Date.now()
    };
    io.emit('ambience:play', playbackState.ambience);
    // Force paused players back to live on track change
    playerSyncState.forEach((state, id) => {
      if (state.syncMode === 'PAUSED') {
        playerSyncState.set(id, { syncMode: 'LIVE', pausedAt: null });
        io.to(id).emit('player:force:rejoin', getLiveState());
      }
    });
    broadcastClientUpdate();
  });

  socket.on('ambience:pause', () => {
    playbackState.ambience.currentTime = getLiveCurrentTime('ambience');
    playbackState.ambience.playing = false;
    playbackState.ambience.playbackStartedAt = null;
    io.emit('ambience:pause');
  });

  socket.on('ambience:stop', () => {
    playbackState.ambience = { track: null, playing: false, volume: playbackState.ambience.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    io.emit('ambience:stop');
  });

  socket.on('ambience:volume', (volume) => {
    playbackState.ambience.volume = volume;
    io.emit('ambience:volume', volume);
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
    playbackState.bgm      = { track: null, playing: false, volume: playbackState.bgm.volume,      currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    playbackState.ambience = { track: null, playing: false, volume: playbackState.ambience.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
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

  // Player local pause/resume (Option D - server-side observer state)
  socket.on('player:local:pause', () => {
    if (playerSyncState.has(socket.id)) {
      playerSyncState.set(socket.id, { syncMode: 'PAUSED', pausedAt: Date.now() });
      console.log(`Player ${socket.id} entered local pause`);
      broadcastClientUpdate();
    }
  });

  socket.on('player:local:resume', () => {
    if (playerSyncState.has(socket.id)) {
      playerSyncState.set(socket.id, { syncMode: 'LIVE', pausedAt: null });
      console.log(`Player ${socket.id} rejoining live sync`);
      // Send live authoritative state so player snaps to correct position
      socket.emit('player:rejoin:state', getLiveState());
      broadcastClientUpdate();
    }
  });

  // ── Dice ──────────────────────────────────────────────────────────────────

  socket.on('dice:roll', (payload) => {
    // payload: { pool, modifiers, label, dc, visibility, roller }
    // pool: [{ sides, count }]  e.g. [{ sides: 20, count: 1 }, { sides: 6, count: 1 }]
    // modifiers: { prof, item, status, circ }  (all numbers, 0 if unused)
    // visibility: 'public' | 'private'
    // roller: player name (self-reported, tied to registered name)

    const { pool, modifiers, label, dc, visibility, roller } = payload;

    // Validate
    if (!pool || !Array.isArray(pool) || pool.length === 0) return;
    const rollerName = roller || socket.playerName || 'Unknown';

    // Roll each die server-side — clients only get the result, not the seed.
    // The 3D animation on each client is cosmetic; this is the authoritative result.
    const diceResults = pool.flatMap(({ sides, count }) =>
      Array.from({ length: count }, () => ({
        sides,
        value: Math.floor(Math.random() * sides) + 1
      }))
    );

    const diceSum   = diceResults.reduce((s, d) => s + d.value, 0);
    const modTotal  = Object.values(modifiers || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const total     = diceSum + modTotal;

    // PF2e nat 20 / nat 1 — only meaningful on a single d20
    const d20rolls  = diceResults.filter(d => d.sides === 20);
    const isNat20   = d20rolls.length === 1 && d20rolls[0].value === 20;
    const isNat1    = d20rolls.length === 1 && d20rolls[0].value === 1;

    const dos = calcDegreeOfSuccess(total, dc ? Number(dc) : null, isNat20, isNat1);

    const record = {
      id:              `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      roller:          rollerName,
      label:           label || null,
      pool,
      modifiers:       modifiers || {},
      modTotal,
      diceResults,
      diceSum,
      total,
      dc:              dc ? Number(dc) : null,
      degreeOfSuccess: dos,
      isNat20,
      isNat1,
      visibility,
      timestamp:       Date.now(),
      socketId:        socket.id,
      role:            socket.role
    };

    addToHistory(record);

    // Build what different audiences see:
    const publicRecord  = { ...record };
    const privateRecord = { ...record, diceResults: null, diceSum: null, total: null,
                            degreeOfSuccess: null, isNat20: false, isNat1: false,
                            redacted: true };

    if (visibility === 'public') {
      // Everyone sees full result
      io.emit('dice:result', publicRecord);
    } else {
      // Private: roller + GM see full, all other players see redacted
      io.sockets.sockets.forEach((s) => {
        if (s.id === socket.id) {
          s.emit('dice:result', publicRecord);  // own result — full
        } else if (s.role === 'dm') {
          s.emit('dice:result', publicRecord);  // GM always sees all
        } else {
          s.emit('dice:result', privateRecord); // other players — redacted
        }
      });
    }

    console.log(`[dice] ${rollerName} rolled ${pool.map(p=>`${p.count}d${p.sides}`).join('+')} = ${total} (${visibility})`);
  });

  // Send roll history for a specific character
  socket.on('dice:history:request', ({ character }) => {
    const history = rollHistory.get(character) || [];
    socket.emit('dice:history', { character, rolls: history });
  });

  // Send the current session feed on connect (for late joiners)
  socket.on('dice:feed:request', () => {
    socket.emit('dice:feed', sessionFeed);
  });

  socket.on('disconnect', () => {
    if (socket.role === 'dm') {
      connectedClients.dm = null;
    } else {
      connectedClients.players.delete(socket.id);
      playerSyncState.delete(socket.id);
    }
    broadcastClientUpdate();
    console.log(`Client disconnected: ${socket.id}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Soundboard server running on http://localhost:${PORT}`);
  console.log(`   DM View: http://localhost:${PORT}`);
  console.log(`   Player View: http://localhost:${PORT}/player.html`);
});