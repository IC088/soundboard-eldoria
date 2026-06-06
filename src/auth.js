// auth.js — Authentication middleware and routes
// Add this to your server.js

// ─── New dependencies (add to package.json) ─────────────────────────────────
// npm install better-sqlite3 express-session connect-better-sqlite3 bcryptjs

// To this — just add express:
const express        = require('express');
const session        = require('express-session');
const SqliteStore    = require('better-sqlite3-session-store')(session);
const { verifyUser, db } = require('./db');
const path           = require('path');

const SESSION_SECRET  = process.env.SESSION_SECRET || 'eldoria-change-this-secret-in-production';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours in ms
const DATA_DIR        = process.env.DB_PATH
  ? path.dirname(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data');

// ─── Session middleware ───────────────────────────────────────────────────────

function setupSession(app) {
  app.use(session({
    store: new SqliteStore({
      client: db,
      expired: {
        clear: true,
        intervalMs: 15 * 60 * 1000
      }
    }),
    secret:            SESSION_SECRET,
    resave:            false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure:   false, // Nginx handles HTTPS termination, cookie travels over HTTP internally
      sameSite: 'lax',
      maxAge:   SESSION_MAX_AGE,
    },
    name: 'eldoria.sid',
  }));
}

// ─── Auth guard middleware ────────────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

// ─── Auth routes ─────────────────────────────────────────────────────────────

function setupAuthRoutes(app) {
  // GET /login — serve login page
  app.get('/login', (req, res) => {
    if (req.session && req.session.user) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  });

  // POST /login — handle credentials
//  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  app.post('/login', (req, res) => {
   const { username, password } = req.body;

    if (!username || !password) {
      return res.redirect(`/login?error=1&username=${encodeURIComponent(username || '')}`);
    }

    const user = verifyUser(username, password);
    if (!user) {
      console.log(`[auth] Failed login attempt for "${username}" from ${req.ip}`);
      return res.redirect(`/login?error=1&username=${encodeURIComponent(username)}`);
    }

    req.session.regenerate((err) => {
      if (err) return res.redirect('/login?error=1');
      req.session.user = user;
      console.log(`[auth] "${user.username}" logged in from ${req.ip}`);
      res.redirect('/');
    });
  });

  // POST /logout
  app.post('/logout', (req, res) => {
    const username = req.session?.user?.username;
    req.session.destroy((err) => {
      if (err) console.error('[auth] Session destroy error:', err);
      if (username) console.log(`[auth] "${username}" logged out`);
      res.clearCookie('eldoria.sid');
      res.redirect('/login');
    });
  });

  // GET /api/me — returns current user info (for GM panel to display username)
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ username: req.session.user.username, role: req.session.user.role });
  });
}

module.exports = { setupSession, setupAuthRoutes, requireAuth };
