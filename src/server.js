const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { setupSession, setupAuthRoutes, requireAuth } = require('./auth');
const { getPlaylistTracks, addTrackToPlaylist, removeTrackFromPlaylist, reorderPlaylist } = require('./db');

const app = express();

// ── Auth ─────────────────────────────────────────────────────────────────────
setupSession(app);
app.use(express.urlencoded({ extended: false })); // needed for login form POST
app.use(express.json());
setupAuthRoutes(app);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// ── Audio directories ─────────────────────────────────────────────────────────
const AUDIO_DIRS = {
  bgm:      path.join(__dirname, 'audio', 'bgm'),
  ambience: path.join(__dirname, 'audio', 'ambience'),
  sfx:      path.join(__dirname, 'audio', 'sfx')
};

Object.values(AUDIO_DIRS).forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── File size limits ──────────────────────────────────────────────────────────
const SIZE_LIMITS = {
  bgm:      500 * 1024 * 1024, // 500MB
  ambience: 500 * 1024 * 1024, // 500MB
  sfx:       10 * 1024 * 1024  //  10MB
};

// ── Multer ────────────────────────────────────────────────────────────────────
const createStorage = (category) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, AUDIO_DIRS[category]),
  filename:    (req, file, cb) => {
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${sanitized}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.webm'];
  cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
};

const uploads = {
  bgm:      multer({ storage: createStorage('bgm'),      fileFilter, limits: { fileSize: SIZE_LIMITS.bgm } }),
  ambience: multer({ storage: createStorage('ambience'), fileFilter, limits: { fileSize: SIZE_LIMITS.ambience } }),
  sfx:      multer({ storage: createStorage('sfx'),      fileFilter, limits: { fileSize: SIZE_LIMITS.sfx } })
};

// ── Static routes ─────────────────────────────────────────────────────────────

// GM panel — requires login
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Player view — public, no auth
app.get('/player.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

// player.js and dice.js sit alongside server.js (not in public/)
app.get('/player.js', (req, res) => res.sendFile(path.join(__dirname, 'player.js')));
app.get('/dice.js',   (req, res) => res.sendFile(path.join(__dirname, 'dice.js')));

// All other static assets (CSS, JS, login.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// Audio file serving
app.use('/audio/bgm',      express.static(AUDIO_DIRS.bgm));
app.use('/audio/ambience', express.static(AUDIO_DIRS.ambience));
app.use('/audio/sfx',      express.static(AUDIO_DIRS.sfx));

// 3D dice WebGL assets
app.use('/assets/dice-box', express.static(path.join(__dirname, 'public', 'assets', 'dice-box')));

// ── Per-room state ────────────────────────────────────────────────────────────
// Each GM gets their own isolated room keyed by username.

const rooms = new Map(); // roomName -> { playbackState, rollHistory, sessionFeed }

function getRoom(name) {
  if (!rooms.has(name)) {
    rooms.set(name, {
      playbackState: {
        bgm:      { track: null, playing: false, volume: 0.5, currentTime: 0, loop: true, duration: null, playbackStartedAt: null },
        ambience: { track: null, playing: false, volume: 0.3, currentTime: 0, loop: true, duration: null, playbackStartedAt: null },
        sfx: []
      },
      rollHistory: new Map(),
      sessionFeed: []
    });
  }
  return rooms.get(name);
}

const MAX_FEED = 100;

function getLiveCurrentTime(room, channel) {
  const ch = room.playbackState[channel];
  if (!ch.playing || ch.playbackStartedAt === null) return ch.currentTime;
  const elapsed = (Date.now() - ch.playbackStartedAt) / 1000;
  const raw = ch.currentTime + elapsed;
  if (ch.loop && ch.duration && ch.duration > 0) return raw % ch.duration;
  return raw;
}

function getLiveState(room) {
  return {
    bgm:      { ...room.playbackState.bgm,      currentTime: getLiveCurrentTime(room, 'bgm') },
    ambience: { ...room.playbackState.ambience, currentTime: getLiveCurrentTime(room, 'ambience') }
  };
}

function addToHistory(room, record) {
  const key = record.roller;
  if (!room.rollHistory.has(key)) room.rollHistory.set(key, []);
  room.rollHistory.get(key).unshift(record);
  if (room.rollHistory.get(key).length > 200) room.rollHistory.get(key).pop();
  room.sessionFeed.unshift(record);
  if (room.sessionFeed.length > MAX_FEED) room.sessionFeed.pop();
}

function calcDegreeOfSuccess(total, dc, isNat20, isNat1) {
  if (!dc) return null;
  const margin = total - dc;
  let degree;
  if      (margin >= 10) degree = 3;
  else if (margin >= 0)  degree = 2;
  else if (margin >= -9) degree = 1;
  else                   degree = 0;
  if (isNat20) degree = Math.min(3, degree + 1);
  if (isNat1)  degree = Math.max(0, degree - 1);
  return ['Critical failure', 'Failure', 'Success', 'Critical success'][degree];
}

// ── Connected clients ─────────────────────────────────────────────────────────
// gmSockets: username -> socket.id  (only live GMs)
// playerSyncState: socket.id -> { syncMode, pausedAt, name, room }

const gmSockets       = new Map(); // username -> socket.id
const playerSyncState = new Map();

function broadcastClientUpdate(roomName) {
  const playerList = [];
  playerSyncState.forEach((state, id) => {
    if (state.room === roomName) {
      playerList.push({ id, name: state.name || id, syncMode: state.syncMode });
    }
  });
  const pausedCount = playerList.filter(p => p.syncMode === 'PAUSED').length;
  const gmOnline = gmSockets.has(roomName);
  io.to(roomName).emit('clients:update', {
    dm: gmOnline,
    players: playerList.length,
    pausedCount,
    playerList
  });
}

function broadcastSessionList() {
  const sessions = [];
  gmSockets.forEach((socketId, username) => {
    sessions.push({ username });
  });
  io.emit('sessions:update', sessions);
}

// ── API routes ────────────────────────────────────────────────────────────────

// Tracks — public read (players need track info too)
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

app.get('/api/limits', (req, res) => {
  res.json({
    bgm:      { limit: SIZE_LIMITS.bgm,      label: '500MB' },
    ambience: { limit: SIZE_LIMITS.ambience, label: '500MB' },
    sfx:      { limit: SIZE_LIMITS.sfx,      label: '10MB'  }
  });
});

app.get('/api/state', (req, res) => {
  // Return state for the requesting GM's own room
  if (req.session && req.session.user) {
    const room = getRoom(req.session.user.username);
    return res.json(room.playbackState);
  }
  res.json({});
});

app.get('/api/sessions', (req, res) => {
  const sessions = [];
  gmSockets.forEach((socketId, username) => sessions.push({ username }));
  res.json(sessions);
});

app.get('/api/dice/history/:character', (req, res) => {
  if (req.session && req.session.user) {
    const room = getRoom(req.session.user.username);
    return res.json({ character: req.params.character, rolls: room.rollHistory.get(req.params.character) || [] });
  }
  res.json({ character: req.params.character, rolls: [] });
});

app.get('/api/dice/feed', (req, res) => {
  if (req.session && req.session.user) {
    const room = getRoom(req.session.user.username);
    return res.json(room.sessionFeed);
  }
  res.json([]);
});

// Upload — GM only (requires auth)
app.post('/api/upload/bgm',      requireAuth, uploads.bgm.array('files', 20),      (req, res) => handleUpload(req, res, 'bgm'));
app.post('/api/upload/ambience', requireAuth, uploads.ambience.array('files', 20), (req, res) => handleUpload(req, res, 'ambience'));
app.post('/api/upload/sfx',      requireAuth, uploads.sfx.array('files', 20),      (req, res) => handleUpload(req, res, 'sfx'));

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

// Delete — GM only (requires auth)
app.delete('/api/tracks/:category/:filename', requireAuth, (req, res) => {
  const { category, filename } = req.params;
  if (!AUDIO_DIRS[category]) return res.status(400).json({ error: 'Invalid category' });
  const filepath = path.join(AUDIO_DIRS[category], filename);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    io.emit('tracks:updated');
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// ── Playlist routes — GM only ─────────────────────────────────────────────────

app.get('/api/playlist', requireAuth, (req, res) => {
  const tracks = getPlaylistTracks(req.session.user.id);
  res.json(tracks);
});

app.post('/api/playlist', requireAuth, (req, res) => {
  const { filename, name, url } = req.body;
  if (!filename || !name || !url) return res.status(400).json({ error: 'Missing fields' });
  const result = addTrackToPlaylist(req.session.user.id, filename, name, url);
  if (!result.success) return res.status(409).json({ error: result.error });
  res.json({ success: true });
});

app.delete('/api/playlist/:id', requireAuth, (req, res) => {
  const removed = removeTrackFromPlaylist(req.session.user.id, Number(req.params.id));
  if (!removed) return res.status(404).json({ error: 'Track not found in playlist' });
  res.json({ success: true });
});

app.put('/api/playlist/reorder', requireAuth, (req, res) => {
  const { order } = req.body; // array of track IDs in new order
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  reorderPlaylist(req.session.user.id, order);
  res.json({ success: true });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    const category = req.path.split('/').pop();
    const limitMB  = SIZE_LIMITS[category] ? SIZE_LIMITS[category] / (1024 * 1024) : 'unknown';
    return res.status(413).json({ error: `File too large. ${category.toUpperCase()} limit is ${limitMB}MB` });
  }
  next(err);
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // ── Register ──────────────────────────────────────────────────────────────
  // GM:     { role: 'dm',     name: <username> }
  // Player: { role: 'player', name: <playerName>, room: <gmUsername> }

  socket.on('register', (payload) => {
    const role = typeof payload === 'string' ? payload : payload.role;
    const name = typeof payload === 'object' && payload.name ? payload.name : null;
    const room = typeof payload === 'object' && payload.room ? payload.room : name;

    socket.role       = role;
    socket.playerName = name;
    socket.room       = role === 'dm' ? name : room; // GMs own their room

    socket.join(socket.room);

    if (role === 'dm') {
      gmSockets.set(name, socket.id);
      broadcastSessionList();
      console.log(`[room] GM "${name}" opened session`);
    } else {
      playerSyncState.set(socket.id, { syncMode: 'LIVE', pausedAt: null, name: name || socket.id, room: socket.room });
    }

    const r = getRoom(socket.room);
    socket.emit('state:sync', getLiveState(r));
    broadcastClientUpdate(socket.room);
  });

  // ── BGM ──────────────────────────────────────────────────────────────────

  socket.on('bgm:play', (data) => {
    const r = getRoom(socket.room);
    r.playbackState.bgm = { ...r.playbackState.bgm, ...data, playing: true, playbackStartedAt: Date.now() };
    io.to(socket.room).emit('bgm:play', r.playbackState.bgm);
    playerSyncState.forEach((state, id) => {
      if (state.room === socket.room && state.syncMode === 'PAUSED') {
        playerSyncState.set(id, { ...state, syncMode: 'LIVE', pausedAt: null });
        io.to(id).emit('player:force:rejoin', getLiveState(r));
      }
    });
    broadcastClientUpdate(socket.room);
  });

  socket.on('bgm:pause', () => {
    const r = getRoom(socket.room);
    r.playbackState.bgm.currentTime       = getLiveCurrentTime(r, 'bgm');
    r.playbackState.bgm.playing           = false;
    r.playbackState.bgm.playbackStartedAt = null;
    io.to(socket.room).emit('bgm:pause');
  });

  socket.on('bgm:stop', () => {
    const r = getRoom(socket.room);
    r.playbackState.bgm = { track: null, playing: false, volume: r.playbackState.bgm.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    io.to(socket.room).emit('bgm:stop');
  });

  socket.on('bgm:volume', (volume) => {
    const r = getRoom(socket.room);
    r.playbackState.bgm.volume = volume;
    io.to(socket.room).emit('bgm:volume', volume);
  });

  socket.on('bgm:seek', (time) => {
    const r = getRoom(socket.room);
    r.playbackState.bgm.currentTime = time;
    if (r.playbackState.bgm.playing) r.playbackState.bgm.playbackStartedAt = Date.now();
    io.to(socket.room).emit('bgm:seek', time);
  });

  socket.on('bgm:loop', (loop) => {
    const r = getRoom(socket.room);
    r.playbackState.bgm.loop = loop;
    io.to(socket.room).emit('bgm:loop', loop);
  });

  // ── Ambience ──────────────────────────────────────────────────────────────

  socket.on('ambience:play', (data) => {
    const r = getRoom(socket.room);
    r.playbackState.ambience = { ...r.playbackState.ambience, ...data, playing: true, playbackStartedAt: Date.now() };
    io.to(socket.room).emit('ambience:play', r.playbackState.ambience);
    playerSyncState.forEach((state, id) => {
      if (state.room === socket.room && state.syncMode === 'PAUSED') {
        playerSyncState.set(id, { ...state, syncMode: 'LIVE', pausedAt: null });
        io.to(id).emit('player:force:rejoin', getLiveState(r));
      }
    });
    broadcastClientUpdate(socket.room);
  });

  socket.on('ambience:pause', () => {
    const r = getRoom(socket.room);
    r.playbackState.ambience.currentTime       = getLiveCurrentTime(r, 'ambience');
    r.playbackState.ambience.playing           = false;
    r.playbackState.ambience.playbackStartedAt = null;
    io.to(socket.room).emit('ambience:pause');
  });

  socket.on('ambience:stop', () => {
    const r = getRoom(socket.room);
    r.playbackState.ambience = { track: null, playing: false, volume: r.playbackState.ambience.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    io.to(socket.room).emit('ambience:stop');
  });

  socket.on('ambience:volume', (volume) => {
    const r = getRoom(socket.room);
    r.playbackState.ambience.volume = volume;
    io.to(socket.room).emit('ambience:volume', volume);
  });

  // ── SFX ───────────────────────────────────────────────────────────────────

  socket.on('sfx:play', (data) => io.to(socket.room).emit('sfx:play', data));

  // ── Fades & master ────────────────────────────────────────────────────────

  socket.on('fade:out', (data) => io.to(socket.room).emit('fade:out', data));
  socket.on('fade:in',  (data) => io.to(socket.room).emit('fade:in',  data));

  socket.on('master:stop', () => {
    const r = getRoom(socket.room);
    r.playbackState.bgm      = { track: null, playing: false, volume: r.playbackState.bgm.volume,      currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    r.playbackState.ambience = { track: null, playing: false, volume: r.playbackState.ambience.volume, currentTime: 0, loop: true, duration: null, playbackStartedAt: null };
    io.to(socket.room).emit('master:stop');
  });

  // ── Player volume (client-side only, no broadcast) ────────────────────────

  socket.on('player:volume:master',   (v) => console.log(`Player ${socket.id} master volume → ${v}`));
  socket.on('player:volume:bgm',      (v) => console.log(`Player ${socket.id} BGM volume → ${v}`));
  socket.on('player:volume:ambience', (v) => console.log(`Player ${socket.id} ambience volume → ${v}`));
  socket.on('player:volume:sfx',      (v) => console.log(`Player ${socket.id} SFX volume → ${v}`));

  // ── Player local pause/resume ─────────────────────────────────────────────

  socket.on('player:local:pause', () => {
    if (playerSyncState.has(socket.id)) {
      const state = playerSyncState.get(socket.id);
      playerSyncState.set(socket.id, { ...state, syncMode: 'PAUSED', pausedAt: Date.now() });
      console.log(`Player ${socket.id} paused locally`);
      broadcastClientUpdate(socket.room);
    }
  });

  socket.on('player:local:resume', () => {
    if (playerSyncState.has(socket.id)) {
      const state = playerSyncState.get(socket.id);
      playerSyncState.set(socket.id, { ...state, syncMode: 'LIVE', pausedAt: null });
      console.log(`Player ${socket.id} rejoining live`);
      const r = getRoom(socket.room);
      socket.emit('player:rejoin:state', getLiveState(r));
      broadcastClientUpdate(socket.room);
    }
  });

  // ── Dice ──────────────────────────────────────────────────────────────────

  socket.on('dice:roll', (payload) => {
    const { pool, modifiers, label, dc, visibility, roller } = payload;
    if (!pool || !Array.isArray(pool) || pool.length === 0) return;

    const rollerName = roller || socket.playerName || 'Unknown';
    const r = getRoom(socket.room);

    const diceResults = pool.flatMap(({ sides, count }) =>
      Array.from({ length: count }, () => ({
        sides,
        value: Math.floor(Math.random() * sides) + 1
      }))
    );

    const diceSum  = diceResults.reduce((s, d) => s + d.value, 0);
    const modTotal = Object.values(modifiers || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    const total    = diceSum + modTotal;

    const d20rolls = diceResults.filter(d => d.sides === 20);
    const isNat20  = d20rolls.length === 1 && d20rolls[0].value === 20;
    const isNat1   = d20rolls.length === 1 && d20rolls[0].value === 1;

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

    addToHistory(r, record);

    const publicRecord  = { ...record };
    const privateRecord = { ...record, diceResults: null, diceSum: null, total: null,
                            degreeOfSuccess: null, isNat20: false, isNat1: false, redacted: true };

    // Only broadcast within this room
    const roomSockets = io.sockets.adapter.rooms.get(socket.room) || new Set();
    roomSockets.forEach((sid) => {
      const s = io.sockets.sockets.get(sid);
      if (!s) return;
      if (visibility === 'public') {
        s.emit('dice:result', publicRecord);
      } else {
        if      (s.id === socket.id) s.emit('dice:result', publicRecord);
        else if (s.role === 'dm')    s.emit('dice:result', publicRecord);
        else                         s.emit('dice:result', privateRecord);
      }
    });

    console.log(`[dice][${socket.room}] ${rollerName} rolled ${pool.map(p => `${p.count}d${p.sides}`).join('+')} = ${total} (${visibility})`);
  });

  socket.on('dice:history:request', ({ character }) => {
    const r = getRoom(socket.room);
    socket.emit('dice:history', { character, rolls: r.rollHistory.get(character) || [] });
  });

  // ── Party sheet updates from players ──────────────────────────────────────
  socket.on('party:sheet:update', (data) => {
    // Broadcast to GM in this room
    const roomSockets = io.sockets.adapter.rooms.get(socket.room) || new Set();
    roomSockets.forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s && s.role === 'dm') s.emit('party:sheet:update', { ...data, name: socket.playerName || data.name });
    });
  });

  socket.on('dice:feed:request', () => {
    const r = getRoom(socket.room);
    socket.emit('dice:feed', r.sessionFeed);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    if (socket.role === 'dm' && socket.playerName) {
      gmSockets.delete(socket.playerName);
      // Notify players in this room that the GM went offline
      io.to(socket.room).emit('gm:offline');
      broadcastSessionList();
      console.log(`[room] GM "${socket.playerName}" closed session`);
    } else {
      playerSyncState.delete(socket.id);
      if (socket.room) broadcastClientUpdate(socket.room);
    }
    console.log(`Client disconnected: ${socket.id}`);
  });
});


// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🎵 Soundboard server running on http://localhost:${PORT}`);
  console.log(`   GM View:     http://localhost:${PORT}`);
  console.log(`   Player View: http://localhost:${PORT}/player.html`);
});