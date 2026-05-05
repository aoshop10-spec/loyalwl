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
      added_at   BIGINT NOT NULL,
      expires_at BIGINT DEFAULT NULL
    )
  `);
  // Migration : ajouter expires_at si manquant (table existante)
  await pool.query(`
    ALTER TABLE ip_whitelist ADD COLUMN IF NOT EXISTS expires_at BIGINT DEFAULT NULL
  `);
  console.log('✅ Base de données prête');
}

// ── Utilitaires ───────────────────────────────────────────────
function now() { return Date.now(); }

function normalizeIp(ip) {
  if (!ip) return '0.0.0.0';
  // Convertir les IPv6-mapped IPv4 (ex: ::ffff:88.173.62.149 → 88.173.62.149)
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return mapped[1];
  return ip;
}

function getClientIp(req) {
  // Support proxy (Railway, etc.)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return normalizeIp(forwarded.split(',')[0].trim());
  }
  return normalizeIp(req.socket?.remoteAddress || req.ip || '0.0.0.0');
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
      'SELECT ip, label, expires_at FROM ip_whitelist WHERE ip = $1',
      [ip]
    );
    if (rows.length > 0) {
      const row = rows[0];
      if (row.expires_at && Date.now() > Number(row.expires_at)) {
        await pool.query('DELETE FROM ip_whitelist WHERE ip = $1', [ip]);
        return res.json({ valid: false, ip, reason: 'expired' });
      }
      return res.json({ valid: true, ip, label: row.label || ip });
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
      'SELECT ip, label, added_at, expires_at FROM ip_whitelist ORDER BY added_at DESC'
    );
    res.json(rows);
  } catch (e) {
    console.error('Erreur GET /api/ips:', e);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── API : Ajouter une IP ──────────────────────────────────────
app.post('/api/ips', requireAdmin, async (req, res) => {
  const { ip, label, duration_hours } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP manquante' });

  // Validation et normalisation IPv4/IPv6
  const ipNorm = normalizeIp(ip.trim());
  const ipv4Rx = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  const ipv6Rx = /^[0-9a-fA-F:]+$/;
  if (!ipv4Rx.test(ipNorm) && !ipv6Rx.test(ipNorm)) {
    return res.status(400).json({ error: 'Format IP invalide' });
  }

  // Calcul de l'expiration (null = permanent)
  let expires_at = null;
  if (duration_hours && Number(duration_hours) > 0) {
    expires_at = Date.now() + Number(duration_hours) * 3600 * 1000;
  }

  try {
    await pool.query(
      `INSERT INTO ip_whitelist (ip, label, added_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (ip) DO UPDATE SET label = EXCLUDED.label, expires_at = EXCLUDED.expires_at`,
      [ipNorm, label?.trim() || '', now(), expires_at]
    );
    res.json({ ok: true, ip: ipNorm, label, expires_at });
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
