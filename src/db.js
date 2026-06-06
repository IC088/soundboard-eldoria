// db.js — SQLite database setup and user helpers
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'soundboard.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT  NOT NULL,
    salt        TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'gm' CHECK(role IN ('admin', 'gm')),
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    filename    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    url         TEXT    NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    added_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);

// ─── Password helpers ───────────────────────────────────────────────────────

function hashPassword(password, salt) {
  return crypto
    .pbkdf2Sync(password, salt, 310000, 32, 'sha256')
    .toString('hex');
}

function createSalt() {
  return crypto.randomBytes(16).toString('hex');
}

// ─── User helpers ────────────────────────────────────────────────────────────

function createUser(username, password, role = 'gm') {
  const salt = createSalt();
  const password_hash = hashPassword(password, salt);

  try {
    const stmt = db.prepare(`
      INSERT INTO users (username, password_hash, salt, role)
      VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(username.toLowerCase().trim(), password_hash, salt, role);
    return { success: true, id: result.lastInsertRowid };
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return { success: false, error: 'Username already exists' };
    }
    throw err;
  }
}

function verifyUser(username, password) {
  const user = db.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).get(username.toLowerCase().trim());

  if (!user) return null;

  const hash = hashPassword(password, user.salt);
  if (hash !== user.password_hash) return null;

  // Update last login timestamp
  db.prepare('UPDATE users SET last_login = unixepoch() WHERE id = ?').run(user.id);

  return { id: user.id, username: user.username, role: user.role };
}

function getUserById(id) {
  return db.prepare('SELECT id, username, role, created_at, last_login FROM users WHERE id = ?').get(id);
}

function getAllUsers() {
  return db.prepare('SELECT id, username, role, created_at, last_login FROM users ORDER BY created_at ASC').all();
}

function deleteUser(username) {
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username.toLowerCase().trim());
  return result.changes > 0;
}

function updatePassword(username, newPassword) {
  const salt = createSalt();
  const password_hash = hashPassword(newPassword, salt);
  const result = db.prepare(
    'UPDATE users SET password_hash = ?, salt = ? WHERE username = ?'
  ).run(password_hash, salt, username.toLowerCase().trim());
  return result.changes > 0;
}

function userCount() {
  return db.prepare('SELECT COUNT(*) as count FROM users').get().count;
}

// ─── Playlist helpers ────────────────────────────────────────────────────────

function getOrCreatePlaylist(userId) {
  let playlist = db.prepare('SELECT * FROM playlists WHERE user_id = ?').get(userId);
  if (!playlist) {
    const result = db.prepare('INSERT INTO playlists (user_id) VALUES (?)').run(userId);
    playlist = { id: result.lastInsertRowid, user_id: userId };
  }
  return playlist;
}

function getPlaylistTracks(userId) {
  const playlist = getOrCreatePlaylist(userId);
  return db.prepare(
    'SELECT * FROM playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, id ASC'
  ).all(playlist.id);
}

function addTrackToPlaylist(userId, filename, name, url) {
  const playlist = getOrCreatePlaylist(userId);
  // Prevent duplicates
  const existing = db.prepare(
    'SELECT id FROM playlist_tracks WHERE playlist_id = ? AND filename = ?'
  ).get(playlist.id, filename);
  if (existing) return { success: false, error: 'Track already in playlist' };

  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) as m FROM playlist_tracks WHERE playlist_id = ?'
  ).get(playlist.id).m;

  db.prepare(
    'INSERT INTO playlist_tracks (playlist_id, filename, name, url, position) VALUES (?, ?, ?, ?, ?)'
  ).run(playlist.id, filename, name, url, maxPos + 1);
  return { success: true };
}

function removeTrackFromPlaylist(userId, trackId) {
  const playlist = getOrCreatePlaylist(userId);
  const result = db.prepare(
    'DELETE FROM playlist_tracks WHERE id = ? AND playlist_id = ?'
  ).run(trackId, playlist.id);
  return result.changes > 0;
}

function reorderPlaylist(userId, orderedIds) {
  const playlist = getOrCreatePlaylist(userId);
  const update = db.prepare(
    'UPDATE playlist_tracks SET position = ? WHERE id = ? AND playlist_id = ?'
  );
  const runAll = db.transaction((ids) => {
    ids.forEach((id, idx) => update.run(idx, id, playlist.id));
  });
  runAll(orderedIds);
  return true;
}

module.exports = {
  db,
  createUser,
  verifyUser,
  getUserById,
  getAllUsers,
  deleteUser,
  updatePassword,
  userCount,
  getPlaylistTracks,
  addTrackToPlaylist,
  removeTrackFromPlaylist,
  reorderPlaylist,
};