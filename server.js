'use strict';

const express = require('express');
const path    = require('path');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ──────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'loyal_admin_2024';

// ── Sessions en mémoire ──────────────────────────────────────
const sessions = new Map(); // token → session object

function genToken(len = 32) {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function now() { return Date.now(); }

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Auth admin ───────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const pwd = req.headers['x-admin-password'];
  if (pwd !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ── Routes API ───────────────────────────────────────────────

// Vérifier un token (appelé par auth.js côté client)
app.get('/api/auth/check', (req, res) => {
  const token = req.query.token;
  if (!token) return res.json({ valid: false, reason: 'Token manquant' });

  const session = sessions.get(token);
  if (!session) return res.json({ valid: false, reason: 'Token invalide ou introuvable' });
  if (session.expiresAt < now()) {
    sessions.delete(token);
    return res.json({ valid: false, reason: 'Session expirée' });
  }

  // Vérif IP si configurée
  const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (session.ip && session.ip !== clientIp) {
    return res.json({ valid: false, reason: `IP non autorisée (attendu: ${session.ip})` });
  }

  session.lastSeen = now();
  res.json({ valid: true, expiresAt: session.expiresAt, label: session.label });
});

// Lister les sessions (admin)
app.get('/api/sessions', requireAdmin, (req, res) => {
  const list = [...sessions.values()].map(s => ({
    ...s,
    expired:   s.expiresAt < now(),
    remaining: Math.max(0, s.expiresAt - now()),
  }));
  res.json(list);
});

// Créer une session (admin)
app.post('/api/sessions', requireAdmin, (req, res) => {
  const { label, ip, duration } = req.body;
  const token = genToken();
  const session = {
    token,
    label:     label || 'Session sans nom',
    ip:        ip || '',
    createdAt: now(),
    expiresAt: now() + (duration || 30 * 60 * 1000),
    lastSeen:  null,
  };
  sessions.set(token, session);
  const link = `${req.protocol}://${req.get('host')}/?token=${token}`;
  res.json({ ...session, link });
});

// Supprimer une session (admin)
app.delete('/api/sessions/:token', requireAdmin, (req, res) => {
  sessions.delete(req.params.token);
  res.json({ ok: true });
});

// Prolonger une session de 30 min (admin)
app.patch('/api/sessions/:token/extend', requireAdmin, (req, res) => {
  const session = sessions.get(req.params.token);
  if (!session) return res.status(404).json({ error: 'Session introuvable' });
  session.expiresAt = now() + 30 * 60 * 1000;
  res.json({ ok: true, expiresAt: session.expiresAt });
});

// Supprimer toutes les sessions (admin)
app.delete('/api/sessions', requireAdmin, (req, res) => {
  sessions.clear();
  res.json({ ok: true });
});

// ── Fallback → index.html ────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Démarrage ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Loyal server running on port ${PORT}`);
});
