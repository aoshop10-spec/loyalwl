// ══════════════════════════════════════════════════════════════
//  Loyal — auth.js  v1.0
//  Système de sessions : token URL + whitelist IP, durée 30 min
//  Panneau admin : gestion des sessions en temps réel
// ══════════════════════════════════════════════════════════════

'use strict';

// ──────────────────────────────────────────
//  CONFIG
// ──────────────────────────────────────────
const AUTH_CONFIG = {
  sessionDuration: 30 * 60 * 1000,  // 30 minutes en ms
  adminPassword:   'loyal_admin_2024', // mot de passe admin
  storageKey:      'loyal_sessions',
  ipKey:           'loyal_ip_whitelist',
  tokenParam:      'token',
};

// ──────────────────────────────────────────
//  UTILITAIRES
// ──────────────────────────────────────────

function genToken(len = 32) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < len; i++) t += chars[Math.floor(Math.random() * chars.length)];
  return t;
}

function now() { return Date.now(); }

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtRemaining(expiresAt) {
  const ms = expiresAt - now();
  if (ms <= 0) return 'Expirée';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s.toString().padStart(2,'0')}s`;
}

// ──────────────────────────────────────────
//  STOCKAGE SESSIONS
// ──────────────────────────────────────────

function getSessions() {
  try { return JSON.parse(localStorage.getItem(AUTH_CONFIG.storageKey) || '[]'); }
  catch { return []; }
}

function saveSessions(sessions) {
  localStorage.setItem(AUTH_CONFIG.storageKey, JSON.stringify(sessions));
}

function getIpWhitelist() {
  try { return JSON.parse(localStorage.getItem(AUTH_CONFIG.ipKey) || '[]'); }
  catch { return []; }
}

function saveIpWhitelist(list) {
  localStorage.setItem(AUTH_CONFIG.ipKey, JSON.stringify(list));
}

// Nettoyer les sessions expirées
function pruneExpired() {
  const sessions = getSessions().filter(s => s.expiresAt > now());
  saveSessions(sessions);
  return sessions;
}

// ──────────────────────────────────────────
//  API SESSIONS — CRUD
// ──────────────────────────────────────────

const SessionManager = {

  // Créer une nouvelle session
  create(label, ip) {
    const token = genToken();
    const session = {
      token,
      label:     label || 'Session sans nom',
      ip:        ip || '',
      createdAt: now(),
      expiresAt: now() + AUTH_CONFIG.sessionDuration,
      lastSeen:  now(),
      active:    true,
    };
    const sessions = getSessions();
    sessions.push(session);
    saveSessions(sessions);
    return session;
  },

  // Prolonger une session de 30 min depuis maintenant
  extend(token) {
    const sessions = getSessions();
    const s = sessions.find(s => s.token === token);
    if (!s) return false;
    s.expiresAt = now() + AUTH_CONFIG.sessionDuration;
    saveSessions(sessions);
    return true;
  },

  // Révoquer (supprimer) une session
  revoke(token) {
    const sessions = getSessions().filter(s => s.token !== token);
    saveSessions(sessions);
  },

  // Révoquer toutes les sessions
  revokeAll() {
    saveSessions([]);
  },

  // Vérifier un token + IP
  validate(token, ip) {
    pruneExpired();
    const sessions = getSessions();
    const s = sessions.find(s => s.token === token && s.active);
    if (!s) return { valid: false, reason: 'Token invalide ou introuvable' };
    if (s.expiresAt < now()) return { valid: false, reason: 'Session expirée' };
    // Vérif IP si renseignée
    if (s.ip && ip && s.ip !== ip) return { valid: false, reason: `IP non autorisée (attendu: ${s.ip})` };
    // Mettre à jour lastSeen
    s.lastSeen = now();
    saveSessions(sessions);
    return { valid: true, session: s };
  },

  // Mettre à jour le label ou l'IP
  update(token, patch) {
    const sessions = getSessions();
    const s = sessions.find(s => s.token === token);
    if (!s) return false;
    if (patch.label !== undefined) s.label = patch.label;
    if (patch.ip !== undefined) s.ip = patch.ip;
    saveSessions(sessions);
    return true;
  },

  // Liste toutes les sessions (avec état)
  list() {
    return getSessions().map(s => ({
      ...s,
      expired:   s.expiresAt < now(),
      remaining: fmtRemaining(s.expiresAt),
      createdFmt: fmtDate(s.createdAt),
      lastSeenFmt: fmtDate(s.lastSeen),
    }));
  },
};

// ──────────────────────────────────────────
//  WHITELIST IP
// ──────────────────────────────────────────

const IpManager = {
  add(ip, label) {
    const list = getIpWhitelist();
    if (list.find(e => e.ip === ip)) return false;
    list.push({ ip, label: label || '', addedAt: now() });
    saveIpWhitelist(list);
    return true;
  },
  remove(ip) {
    saveIpWhitelist(getIpWhitelist().filter(e => e.ip !== ip));
  },
  list() {
    return getIpWhitelist();
  },
  has(ip) {
    return getIpWhitelist().some(e => e.ip === ip);
  },
};

// ──────────────────────────────────────────
//  VÉRIFICATION AU CHARGEMENT (côté app)
// ──────────────────────────────────────────

function checkAuth() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get(AUTH_CONFIG.tokenParam);

  if (!token) {
    // Vérifier si IP whitelistée (simulé côté client — en prod utiliser un backend)
    const storedToken = sessionStorage.getItem('loyal_token');
    if (storedToken) {
      const result = SessionManager.validate(storedToken, null);
      if (result.valid) return result.session;
    }
    redirectToLogin('Aucun token fourni');
    return null;
  }

  const result = SessionManager.validate(token, null);
  if (!result.valid) {
    redirectToLogin(result.reason);
    return null;
  }

  // Stocker en sessionStorage pour ne pas exposer dans l'URL
  sessionStorage.setItem('loyal_token', token);

  // Nettoyer l'URL (retirer le token visible)
  const clean = new URL(window.location.href);
  clean.searchParams.delete(AUTH_CONFIG.tokenParam);
  window.history.replaceState({}, '', clean.toString());

  return result.session;
}

function redirectToLogin(reason) {
  const url = new URL('login.html', window.location.href);
  if (reason) url.searchParams.set('reason', reason);
  window.location.replace(url.toString());
}

// ──────────────────────────────────────────
//  MINUTEUR SESSION (côté app)
// ──────────────────────────────────────────

let _sessionTimer = null;
let _currentSession = null;

function startSessionTimer(session) {
  _currentSession = session;
  if (_sessionTimer) clearInterval(_sessionTimer);

  _sessionTimer = setInterval(() => {
    const remaining = _currentSession.expiresAt - now();
    const el = document.getElementById('sessionCountdown');

    if (remaining <= 0) {
      clearInterval(_sessionTimer);
      sessionStorage.removeItem('loyal_token');
      alert('⏰ Votre session a expiré. Vous allez être redirigé.');
      redirectToLogin('Session expirée');
      return;
    }

    if (el) {
      const m = Math.floor(remaining / 60000);
      const s = Math.floor((remaining % 60000) / 1000);
      el.textContent = `Session: ${m}m ${s.toString().padStart(2,'0')}s`;
      el.style.color = remaining < 5 * 60000 ? 'var(--red)' : 'var(--text-2)';
    }

    // Alerte 5 min avant
    if (remaining > 299000 && remaining < 301000) {
      if (typeof showToast === 'function') showToast('⚠️ Session expire dans 5 min', 'err');
    }
  }, 1000);
}

// Export global
window.Auth = {
  checkAuth,
  SessionManager,
  IpManager,
  genToken,
  fmtDate,
  fmtRemaining,
  startSessionTimer,
  redirectToLogin,
  AUTH_CONFIG,
};
