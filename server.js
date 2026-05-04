'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'loyal_admin_2024';

// ── PostgreSQL ───────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      label       TEXT NOT NULL DEFAULT 'Session sans nom',
      ip          TEXT DEFAULT '',
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      last_seen   BIGINT
    )
  `);
  console.log('✅ Base de données prête');
}

// ── Utilitaires ──────────────────────────────────────────────
function genToken(len = 32) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}
function now() { return Date.now(); }

// ── Middleware ───────────────────────────────────────────────
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Auth admin ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ── Routes API ───────────────────────────────────────────────

app.get('/api/auth/check', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ valid: false, reason: 'Token manquant' });

  try {
    const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
    const session = rows[0];

    if (!session) return res.json({ valid: false, reason: 'Token invalide ou introuvable' });
    if (session.expires_at < now()) {
      await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
      return res.json({ valid: false, reason: 'Session expirée' });
    }

    const clientIp = (req.ip || req.headers['x-forwarded-for']?.split(',')[0] || '').replace(/^::ffff:/, '').trim();
    if (session.ip && session.ip !== clientIp) {
      return res.json({ valid: false, reason: `IP non autorisée (attendu: ${session.ip}, reçu: ${clientIp})` });
    }

    await pool.query('UPDATE sessions SET last_seen = $1 WHERE token = $2', [now(), token]);
    res.json({ valid: true, expiresAt: session.expires_at, label: session.label });

  } catch (e) {
    console.error(e);
    res.status(500).json({ valid: false, reason: 'Erreur serveur' });
  }
});

app.get('/api/sessions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM sessions ORDER BY created_at DESC');
    res.json(rows.map(s => ({
      token:     s.token,
      label:     s.label,
      ip:        s.ip,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      lastSeen:  s.last_seen,
      expired:   s.expires_at < now(),
      remaining: Math.max(0, s.expires_at - now()),
    })));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/sessions', requireAdmin, async (req, res) => {
  const { label, ip, duration } = req.body;
  const token     = genToken();
  const createdAt = now();
  const expiresAt = now() + (duration || 30 * 60 * 1000);

  try {
    await pool.query(
      'INSERT INTO sessions (token, label, ip, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [token, label || 'Session sans nom', ip || '', createdAt, expiresAt]
    );
    const link = `${req.protocol}://${req.get('host')}/?token=${token}`;
    res.json({ token, label, ip, createdAt, expiresAt, link });
  } catch (e) {
    res.status(500).json({ error: 'Erreur création session' });
  }
});

app.delete('/api/sessions/:token', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE token = $1', [req.params.token]);
  res.json({ ok: true });
});

app.patch('/api/sessions/:token/extend', requireAdmin, async (req, res) => {
  const expiresAt = now() + 30 * 60 * 1000;
  await pool.query('UPDATE sessions SET expires_at = $1 WHERE token = $2', [expiresAt, req.params.token]);
  res.json({ ok: true, expiresAt });
});

app.delete('/api/sessions', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM sessions');
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Démarrage ────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Loyal server running on port ${PORT}`));
}).catch(e => {
  console.error('❌ Erreur DB:', e);
  process.exit(1);
});
