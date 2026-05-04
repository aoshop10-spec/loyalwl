'use strict';

const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'loyal_admin_2024';

// ── PostgreSQL ───────────────────────────────────────────────
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL manquant dans les variables d\'environnement !');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ip_whitelist (
        ip         TEXT PRIMARY KEY,
        label      TEXT NOT NULL DEFAULT '',
        added_at   BIGINT NOT NULL
      )
    `);
    console.log('✅ Base de données prête');
  } catch (e) {
    console.error('❌ Erreur création table:', e.message);
    throw e;
  }
}

// ── Utilitaires ──────────────────────────────────────────────
function now() { return Date.now(); }

function getClientIp(req) {
  const raw = req.headers['x-forwarded-for']?.split(',')[0] || req.ip || '';
  return raw.replace(/^::ffff:/, '').trim();
}

// ── Middleware ───────────────────────────────────────────────
app.set('trust proxy', true);
app.use(express.json());

// ── Auth admin ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ── Routes API ───────────────────────────────────────────────

// IP du visiteur
app.get('/api/myip', (req, res) => {
  res.json({ ip: getClientIp(req) });
});

// Vérification d'accès par IP
app.get('/api/auth/check', async (req, res) => {
  const clientIp = getClientIp(req);
  try {
    const { rows } = await pool.query('SELECT * FROM ip_whitelist WHERE ip = $1', [clientIp]);
    if (rows.length > 0) {
      res.json({ valid: true, label: rows[0].label, ip: clientIp });
    } else {
      res.json({ valid: false, reason: 'Adresse IP non autorisée', ip: clientIp });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ valid: false, reason: 'Erreur serveur' });
  }
});

// Lister les IPs whitelistées (admin)
app.get('/api/ips', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM ip_whitelist ORDER BY added_at DESC');
    res.json(rows.map(r => ({ ip: r.ip, label: r.label, addedAt: r.added_at })));
  } catch (e) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Ajouter une IP (admin)
app.post('/api/ips', requireAdmin, async (req, res) => {
  const { ip, label } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP manquante' });
  try {
    await pool.query(
      'INSERT INTO ip_whitelist (ip, label, added_at) VALUES ($1, $2, $3) ON CONFLICT (ip) DO UPDATE SET label = $2',
      [ip.trim(), label || '', now()]
    );
    res.json({ ok: true, ip: ip.trim(), label: label || '' });
  } catch (e) {
    res.status(500).json({ error: 'Erreur ajout IP' });
  }
});

// Supprimer une IP (admin)
app.delete('/api/ips/:ip', requireAdmin, async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  await pool.query('DELETE FROM ip_whitelist WHERE ip = $1', [ip]);
  res.json({ ok: true });
});

// Supprimer toutes les IPs (admin)
app.delete('/api/ips', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM ip_whitelist');
  res.json({ ok: true });
});

// Mettre à jour le label d'une IP (admin)
app.patch('/api/ips/:ip', requireAdmin, async (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  const { label } = req.body;
  await pool.query('UPDATE ip_whitelist SET label = $1 WHERE ip = $2', [label || '', ip]);
  res.json({ ok: true });
});

// Fichiers statiques (après les routes API)
app.use(express.static(path.join(__dirname)));

// Ne pas intercepter les routes admin ou les fichiers .html existants
app.get('*', (req, res) => {
  if (req.path.endsWith('.html') || req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Démarrage ────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`✅ Loyal server running on port ${PORT}`));
}).catch(e => {
  console.error('❌ Erreur DB:', e);
  process.exit(1);
});
