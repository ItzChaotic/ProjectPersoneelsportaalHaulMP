'use strict';

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const Database = require('better-sqlite3');
const SQLiteStore = require('connect-sqlite3')(session);
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 8080);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'drivershub.sqlite');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Database tabellen initialiseren
db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 discord_id TEXT NOT NULL UNIQUE,
 display_name TEXT NOT NULL,
 avatar_url TEXT,
 role TEXT NOT NULL DEFAULT 'Chauffeur',
 distance TEXT DEFAULT '0 km',
 deliveries INTEGER DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS trips (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER REFERENCES users(id),
 cargo TEXT, pickup_city TEXT, delivery_city TEXT,
 distance_km REAL NOT NULL DEFAULT 0,
 completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS announcements (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL, content TEXT NOT NULL, username TEXT NOT NULL, date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS convoys (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 title TEXT NOT NULL, date TEXT NOT NULL, time TEXT, server TEXT, route TEXT, details TEXT, username TEXT
);
CREATE TABLE IF NOT EXISTS convoy_signups (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 convoy_id INTEGER REFERENCES convoys(id) ON DELETE CASCADE,
 username TEXT NOT NULL, UNIQUE(convoy_id, username)
);
CREATE TABLE IF NOT EXISTS gallery (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 url TEXT NOT NULL, uploaded_by TEXT NOT NULL, date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS socials (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 platform TEXT NOT NULL, url TEXT NOT NULL, added_by TEXT NOT NULL
);
`);

const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit voor upload

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'BRECHT-TRANSPORT-SECRET-KEY',
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: path.dirname(path.resolve(DB_PATH)) }),
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(passport.initialize());
app.use(passport.session());

// Discord Authenticatie instellen
const managementIds = (process.env.MANAGEMENT_DISCORD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try { done(null, db.prepare('SELECT * FROM users WHERE id=?').get(id) || false); } catch (e) { done(e); }
});

if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
  passport.use('discord', new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/discord/return`,
    scope: ['identify']
  }, (accessToken, refreshToken, profile, done) => {
    try {
      const isManagement = managementIds.includes(String(profile.id));
      const role = isManagement ? 'Directeur' : 'Chauffeur';
      const avatarUrl = profile.avatar ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` : null;

      let user = db.prepare('SELECT * FROM users WHERE discord_id=?').get(String(profile.id));
      if (user) {
        db.prepare('UPDATE users SET display_name=?, avatar_url=? WHERE id=?').run(profile.username, avatarUrl, user.id);
      } else {
        const res = db.prepare('INSERT INTO users(discord_id, display_name, avatar_url, role) VALUES(?,?,?,?)').run(String(profile.id), profile.username, avatarUrl, role);
        user = db.prepare('SELECT * FROM users WHERE id=?').get(res.lastInsertRowid);
      }
      return done(null, user);
    } catch (e) { done(e); }
  }));
}

// Routes
app.get('/auth/discord', passport.authenticate('discord'));
app.get('/auth/discord/return', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/portal'));
app.get('/api/me', (req, res) => req.isAuthenticated() ? res.json(req.user) : res.status(401).json({ error: 'Niet ingelogd' }));
app.get('/logout', (req, res) => req.logout(() => res.redirect('/')));

// HaulMP / VTC Data Endpoint voor de frontend
app.get('/api/haulmp', (req, res) => {
  const drivers = db.prepare(`SELECT display_name AS username, role, avatar_url AS avatarUrl, distance, deliveries FROM users`).all();
  const recentJobs = db.prepare(`SELECT t.distance_km || ' km' AS distance, t.pickup_city AS 'from', t.delivery_city AS 'to', u.display_name AS driver FROM trips t JOIN users u ON u.id=t.user_id ORDER BY t.completed_at DESC LIMIT 10`).all();
  const totalStats = db.prepare(`SELECT COUNT(*) AS deliveries, COALESCE(SUM(distance_km), 0) AS total_km FROM trips`).get();
  
  res.json({
    distance: `${Math.round(totalStats.total_km)} km`,
    deliveries: totalStats.deliveries,
    drivers: drivers.length,
    drivers_list: drivers.map(d => ({ ...d, color: 'red', isDev: false })),
    recent_jobs: recentJobs,
    announcements: db.prepare(`SELECT * FROM announcements ORDER BY id DESC`).all(),
    convoysList: db.prepare(`SELECT * FROM convoys ORDER BY id DESC`).all(),
    socialsList: db.prepare(`SELECT * FROM socials ORDER BY id DESC`).all()
  });
});

app.get('/api/gallery', (req, res) => {
  res.json(db.prepare(`SELECT * FROM gallery ORDER BY id DESC`).all());
});

// Statische bestanden (index.html en assets) koppelen
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Brecht Transport Portaal draait op Koyeb via poort ${PORT}`));
