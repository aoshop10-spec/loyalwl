'use strict';

const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'monmotdepasse';

// ── PostgreSQL ────────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquant dans les variables d\'environnement !');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

async function initDB() {
  // Table whitelist IP
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_whitelist (
      ip         TEXT PRIMARY KEY,
      label      TEXT NOT NULL DEFAULT '',
      added_at   BIGINT NOT NULL
    )
  `);
  console.log('✅ Base de données prête');
}

// ── Utilitaires ───────────────────────────────────────────────
function now() { return Date.now(); }

function getClientIp(req) {
  // Support proxy (Railway, etc.)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', true);
app.use(express.json());

// Middleware admin : vérifie le header x-admin-password
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── API : Vérification IP (appelée par index.html au chargement) ──
app.get('/api/auth/check', async (req, res) => {
  const ip = getClientIp(req);
  try {
    const { rows } = await pool.query(
      'SELECT ip, label FROM ip_whitelist WHERE ip = $1',
      [ip]
    );
    if (rows.length > 0) {
      return res.json({ valid: true, ip, label: rows[0].label || ip });
    }
    return res.json({ valid: false, ip });
  } catch (e) {
    console.error('Erreur auth/check:', e);
    return res.status(500).json({ valid: false, ip, error: 'Erreur serveur' });
  }
});

// ── API : Lister les IPs whitelistées ────────────────────────
app.get('/api/ips', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT ip, label, added_at FROM ip_whitelist ORDER BY added_at DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error('Erreur GET /api/ips:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── API : Ajouter une IP ──────────────────────────────────────
app.post('/api/ips', requireAdmin, async (req, res) => {
  const { ip, label } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP manquante' });

  // Validation basique du format IPv4/IPv6
  const ipv4Rx = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (!ipv4Rx.test(ip)) {
    return res.status(400).json({ error: 'Format IP invalide' });
  }

  try {
    await pool.query(
      `INSERT INTO ip_whitelist (ip, label, added_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (ip) DO UPDATE SET label = EXCLUDED.label`,
      [ip.trim(), label?.trim() || '', now()]
    );
    res.json({ ok: true, ip, label });
  } catch (e) {
    console.error('Erreur POST /api/ips:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── API : Supprimer une IP ────────────────────────────────────
app.delete('/api/ips/:ip', requireAdmin, async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  try {
    await pool.query('DELETE FROM ip_whitelist WHERE ip = $1', [ip]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Erreur DELETE /api/ips:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Fichiers statiques ────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Fallback ──────────────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route introuvable' });
  }
  if (req.path.endsWith('.html')) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Démarrage ─────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Loyal server démarré sur le port ${PORT}`));
}).catch(e => {
  console.error('❌ Erreur DB:', e);
  process.exit(1);
});
