// ══════════════════════════════════════════════════════════════
//  Loyal v2.1 — app.js
//  Parser avancé : identité, famille, IPs, DB lines, diplômes, emplois
// ══════════════════════════════════════════════════════════════

'use strict';

let records = JSON.parse(localStorage.getItem('loyal_records') || '[]');
let currentIdx = 0;
let currentView = 'dsc';

// ══════════════════════════════════════════
//  UTILITAIRES
// ══════════════════════════════════════════

function formatTel(t) {
  if (!t) return '';
  const d = t.replace(/\D/g, '').replace(/^33/, '0');
  if (d.length === 10) return d.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
  return t.trim();
}

function capitalizeName(s) {
  if (!s) return '';
  return s.split(/[\s\-]/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s || ''; }

function getPref(key, def) {
  try {
    const p = JSON.parse(localStorage.getItem('loyal_prefs') || '{}');
    return p[key] !== undefined ? p[key] : def;
  } catch { return def; }
}

// ══════════════════════════════════════════
//  RELATIONS FAMILIALES
// ══════════════════════════════════════════

const FAMILY_KEYWORDS = {
  'père': 'Père', 'papa': 'Père', 'father': 'Père',
  'mère': 'Mère', 'mere': 'Mère', 'mama': 'Mère', 'maman': 'Mère', 'mother': 'Mère',
  'frère': 'Frère', 'frere': 'Frère', 'brother': 'Frère',
  'sœur': 'Sœur', 'soeur': 'Sœur', 'sister': 'Sœur',
  'tonton': 'Tonton', 'oncle': 'Oncle', 'uncle': 'Oncle',
  'tatie': 'Tatie', 'tante': 'Tante', 'aunt': 'Tante',
  'grand-père': 'Grand-père', 'grandpere': 'Grand-père', 'papie': 'Papi', 'papi': 'Papi', 'grandfather': 'Grand-père',
  'grand-mère': 'Grand-mère', 'grandmere': 'Grand-mère', 'mamie': 'Mamie', 'grand mere': 'Grand-mère', 'grandmother': 'Grand-mère',
  'cousin': 'Cousin', 'cousine': 'Cousine',
  'fils': 'Fils', 'fille': 'Fille', 'enfant': 'Enfant',
  'copain': 'Copain', 'copine': 'Copine', 'ami': 'Ami', 'amie': 'Amie',
};

// ══════════════════════════════════════════
//  PARSING PRINCIPAL
// ══════════════════════════════════════════

function parseText(raw) {
  // Détecter si le texte contient des relations familiales
  const hasFamilyKeywords = Object.keys(FAMILY_KEYWORDS).some(k =>
    new RegExp('(^|\\n)\\s*' + k + '\\s*[:\\-]', 'im').test(raw)
  );

  if (hasFamilyKeywords && getPref('parseFamily', true)) {
    return parseFamilyBlock(raw);
  }

  // Sinon, découpe par blocs (ligne vide)
  const blocks = raw.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const toProcess = blocks.length === 1 ? trySubdivide(raw) : blocks;
  return toProcess.map(parseBlock).filter(r => r.prenom || r.nom || r.email || r.mobile || r.ips.length);
}

function trySubdivide(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const looksLikeRows = lines.filter(l =>
    l.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/i) || l.match(/\b0[67]\d{8}\b/)
  );
  if (looksLikeRows.length > 1) return lines;
  return [raw];
}

// ── Parse un bloc avec réseau familial ──
function parseFamilyBlock(raw) {
  // La cible principale = les infos avant le premier mot-clé familial
  const lines = raw.split('\n');
  const familyMembers = [];
  let mainLines = [];
  let currentRelation = null;
  let currentBlock = [];

  const familyRx = new RegExp('^(' + Object.keys(FAMILY_KEYWORDS).join('|') + ')\\s*[:\\-]\\s*(.*)$', 'im');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Chercher un label de relation en début de ligne
    let foundRelation = null;
    for (const [kw, label] of Object.entries(FAMILY_KEYWORDS)) {
      const rx = new RegExp('^' + kw + '\\s*[:\\-]\\s*(.*)', 'i');
      const m = trimmed.match(rx);
      if (m) {
        foundRelation = { label, name: m[1].trim() };
        break;
      }
    }

    if (foundRelation) {
      // Sauver le bloc précédent
      if (currentRelation && currentBlock.length) {
        familyMembers.push({ relation: currentRelation, lines: currentBlock });
      } else if (!currentRelation && currentBlock.length) {
        mainLines = currentBlock;
      }
      currentRelation = foundRelation;
      currentBlock = foundRelation.name ? [foundRelation.name] : [];
    } else {
      currentBlock.push(trimmed);
    }
  }

  // Dernier bloc
  if (currentRelation && currentBlock.length) {
    familyMembers.push({ relation: currentRelation, lines: currentBlock });
  } else if (!currentRelation && currentBlock.length) {
    mainLines = currentBlock;
  }

  // Parser la cible principale
  const mainRecord = parseBlock(mainLines.join('\n'));
  mainRecord._familyMembers = familyMembers.map(fm => parseFamilyMember(fm));

  return [mainRecord];
}

function parseFamilyMember(fm) {
  const { relation, lines } = fm;
  const text = lines.join('\n');
  const member = {
    relation: relation.label,
    nom: '',
    prenom: '',
    adresse: '',
    pays: '',
    emploi: '',
    diplomes: [],
    anciensTaffs: [],
    infos: [],
  };

  // Nom depuis la première ligne si pas de label
  const firstLine = lines[0] || '';
  if (firstLine && !/^(adresse|taff|emploi|diplom|ancien)/i.test(firstLine)) {
    const parts = firstLine.split(/\s+/);
    if (parts.length >= 2) {
      const hasCaps = parts.find(p => p === p.toUpperCase() && p.length > 1 && /[A-Z]/.test(p));
      if (hasCaps) {
        member.nom = hasCaps;
        member.prenom = capitalizeName(parts.filter(p => p !== hasCaps).join(' '));
      } else {
        member.prenom = capitalizeName(parts[0]);
        member.nom = parts.slice(1).join(' ').toUpperCase();
      }
    } else {
      member.nom = firstLine.toUpperCase();
    }
  }

  // Parcourir les lignes pour extraire les infos
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    // Adresse
    if (/^(adresse|habite|réside|reside)\s*[:\-]?\s*/i.test(t)) {
      member.adresse = t.replace(/^(adresse|habite|réside|reside)\s*[:\-]?\s*/i, '').trim();
      continue;
    }
    // Taff / emploi actuel
    if (/^(taff|emploi|travail|boulot|job|poste)\s*[:\-]?\s*/i.test(t)) {
      const val = t.replace(/^(taff|emploi|travail|boulot|job|poste)\s*[:\-]?\s*/i, '').trim();
      if (val && val !== 'aucune information') member.emploi = val;
      continue;
    }
    // Anciens taffs / diplômes
    if (/^(ancien|anciens|diplom|etude|études|parcours)/i.test(t)) continue;
    // Lignes numérotées (1. 2. etc)
    const numM = t.match(/^(\d+)\.\s*(.*)/);
    if (numM) {
      const info = numM[2].trim();
      if (/^(études|etude|a étudié|diplom)/i.test(info)) {
        member.diplomes.push(info.replace(/^(études|etude|a étudié[eé]?\s*à?\s*|diplom[eé]?\s*[:\-]?\s*)/i, '').trim());
      } else if (/^(travail|a travaillé|travaille|emploi|poste|conseill)/i.test(info)) {
        member.anciensTaffs.push(info.replace(/^(travail[a-zé]+\s*(chez|à|a)?\s*|emploi[:\s]*|poste[:\s]*)/i, '').trim());
      } else {
        member.infos.push(info);
      }
    }
  }

  return member;
}

// ── Parse un bloc individuel ──
function parseBlock(block) {
  const r = {
    // État Civil
    sexe: '', prenom: '', nom: '',
    dateNaissance: '', villeNaissance: '', paysNaissance: '', deptNaissance: '',
    statutIdentite: '', dateCreationIdentite: '', dateModifIdentite: '',
    // Contact
    mobile: '', telephone: '', numeroContact: '',
    email: '', emailSubscription: '',
    dateCreationContact: '', dateModifContact: '',
    // Adresse
    numeroVoie: '', complementAdresse: '', codePostal: '', ville: '',
    idAdresse: '', idAdresseSubscription: '', etageSubscription: '',
    cpSubscription: '', nomRueSubscription: '', numRueSubscription: '',
    // Compte
    dateCreationCompte: '', loginCompte: '', peutEtreAssocie: '', login: '', enfants: '', enfantActif: '',
    // Offre
    jourAnniversaire: '', peutTerminerOffre: '', dateCreationOffre: '', blocageOffre: '', statutInterneOffre: '', dateModifOffre: '',
    // Avancé
    ips: [],
    discordId: '', discordUsername: '', liveId: '',
    licenseKey: '', dbRaw: '',
    diplomes: [], emplois: [],
    // Famille
    _familyMembers: [],
    _raw: block,
  };

  const text = block;
  const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

  // ── LIGNE DB (tuple SQL) ──
  if (getPref('parseDB', true)) {
    const dbM = text.match(/\(\s*\d+\s*,\s*'[^']*'/);
    if (dbM) {
      r.dbRaw = text;
      // license
      const licM = text.match(/'license:([a-f0-9]{32,})'/i);
      if (licM) r.licenseKey = licM[1];
      // discord ID
      const discM = text.match(/'discord:(\d{15,20})'/i);
      if (discM) r.discordId = discM[1];
      // live ID
      const liveM = text.match(/'live:(\d{15,20})'/i);
      if (liveM) r.liveId = liveM[1];
      // Username entre guillemets (souvent le pseudo)
      const userM = [...text.matchAll(/'([^']{3,40})'/g)].map(m => m[1])
        .filter(s => !s.startsWith('license:') && !s.startsWith('discord:') && !s.startsWith('live:') && !/^\d+$/.test(s));
      if (userM.length) r.loginCompte = userM[0];
    }
  }

  // ── IPs ──
  if (getPref('parseIP', true)) {
    const ipRx = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g;
    const found = [];
    let m;
    while ((m = ipRx.exec(text)) !== null) {
      if (!found.includes(m[1])) found.push(m[1]);
    }
    r.ips = found;
  }

  // ── EMAIL ──
  const emailM = text.match(/\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/);
  if (emailM) { r.email = emailM[1]; r.emailSubscription = emailM[1]; }

  // ── TÉLÉPHONES ──
  const tels = [...text.matchAll(/\b((?:\+33|0)[1-9](?:[\s.\-]?\d{2}){4})\b/g)].map(m => m[1].replace(/[\s.\-]/g, ''));
  if (tels[0]) r.mobile = formatTel(tels[0]);
  if (tels[1]) r.telephone = formatTel(tels[1]);
  if (tels[2]) r.numeroContact = formatTel(tels[2]);

  // ── CODE POSTAL ──
  const cpM = text.match(/\b(\d{5})\b/);
  if (cpM) { r.codePostal = cpM[1]; r.cpSubscription = cpM[1]; }

  // ── DATES ──
  const dates = [...text.matchAll(/\b(\d{2}[\/\-]\d{2}[\/\-]\d{4})\b/g)].map(m => m[1].replace(/-/g, '/'));
  if (dates[0]) r.dateNaissance = dates[0];

  // ── ADRESSE ──
  const addrM = text.match(/(\d+[\s,]+(?:rue|avenue|av\.?|bd|boulevard|allée|allee|impasse|chemin|place|voie|route|passage|square|résidence|residence|rte)\b[^\n,;]{3,60})/i);
  if (addrM) {
    r.numeroVoie = addrM[1].trim();
    r.nomRueSubscription = addrM[1].replace(/^\d+\s*/,'').trim();
    const numM = addrM[1].match(/^(\d+)/);
    if (numM) r.numRueSubscription = numM[1];
  }

  // ── VILLE ──
  const villeM = text.match(/\b\d{5}\s+([A-ZÀ-Ÿa-zà-ÿ\s\-]{2,30})/);
  if (villeM) r.ville = villeM[1].trim().toUpperCase();

  // Ville sans CP (format "Habite à X, Rhone-Alpes")
  if (!r.ville) {
    const villeM2 = text.match(/(?:habite\s*à|réside?\s*à|adresse\s*[:–]?\s*)([A-ZÀ-Ÿa-zà-ÿ][^\n,]{2,30})/i);
    if (villeM2) r.ville = villeM2[1].trim();
  }

  // ── SEXE ──
  if (/\b(mme|madame|femme)\b/i.test(text)) r.sexe = 'MME';
  else if (/\b(m\.|mr|monsieur|homme)\b/i.test(text)) r.sexe = 'M.';

  // ── LABELS KEY:VALUE ──
  for (const line of lines) {
    const kv = line.match(/^([^:]{1,40}?)\s*[:\-]\s*(.+)$/);
    if (!kv) continue;
    const k = kv[1].toLowerCase().trim();
    const v = kv[2].trim();
    if (!v || v === 'aucune information') continue;

    if (/^(nom|last.?name|surname)$/.test(k)) r.nom = v.toUpperCase();
    else if (/^(pr[eé]nom|first.?name)$/.test(k)) r.prenom = capitalizeName(v);
    else if (/^(email|mail|courriel|e-mail)$/.test(k)) { r.email = v; r.emailSubscription = v; }
    else if (/^(mobile|m\.?sub|tel\.?mobile|téléphone mobile)$/.test(k)) r.mobile = formatTel(v);
    else if (/^(t[eé]l[eé]phone|tel|phone|t[eé]l|num[eé]ro)$/.test(k)) r.telephone = formatTel(v);
    else if (/^(num[eé]ro.?contact|contact)$/.test(k)) r.numeroContact = formatTel(v);
    else if (/^(adresse|address|addr)$/.test(k)) r.numeroVoie = v;
    else if (/^(ville|city)$/.test(k)) r.ville = v.toUpperCase();
    else if (/^(code.?postal|cp|zip)$/.test(k)) r.codePostal = v;
    else if (/^(date.?naissance|naissance|birthday|ddn|né.?le|née.?le)$/.test(k)) r.dateNaissance = v;
    else if (/^(ville.?naissance|lieu.?naissance)$/.test(k)) r.villeNaissance = v.toUpperCase();
    else if (/^(pays.?naissance|pays)$/.test(k)) r.paysNaissance = v.toUpperCase();
    else if (/^(d[eé]pt?.?naissance|d[eé]partement)$/.test(k)) r.deptNaissance = v;
    else if (/^(sexe|genre)$/.test(k)) r.sexe = v.toUpperCase();
    else if (/^(login|identifiant|id.?compte|pseudo|username)$/.test(k)) { r.login = v; r.loginCompte = v; }
    else if (/^(complement|compl[eé]ment.?adresse)$/.test(k)) r.complementAdresse = v;
    else if (/^(statut.?identit[eé]|statut)$/.test(k)) r.statutIdentite = v.toLowerCase();
    else if (/^(discord|discord.?id)$/.test(k)) r.discordId = v;
    else if (/^(ip|adresse.?ip)$/.test(k)) { if (!r.ips.includes(v)) r.ips.push(v); }

    // Diplômes / emplois via labels
    else if (/^(dipl[oô]me|formation|[eé]tudes?|certif)/.test(k)) r.diplomes.push(`${kv[1]}: ${v}`);
    else if (/^(emploi|taff|travail|poste|soci[eé]t[eé]|entreprise|job)/.test(k)) r.emplois.push(`${kv[1]}: ${v}`);
  }

  // ── DISCORD dans texte libre ──
  const discordFree = text.match(/discord[:\s]+([a-zA-Z0-9_.#]{2,32})/i);
  if (discordFree && !r.discordId) r.discordUsername = discordFree[1];

  // ── NOM/PRÉNOM heuristique ──
  if (!r.nom && !r.prenom) {
    const nameGuess = guessName(lines, r);
    r.nom = nameGuess.nom;
    r.prenom = nameGuess.prenom;
  }

  // ── DEFAULTS ──
  if (!r.statutIdentite) r.statutIdentite = 'actif';
  if (!r.peutEtreAssocie) r.peutEtreAssocie = 'true';
  if (!r.enfantActif) r.enfantActif = 'false';
  if (!r.peutTerminerOffre) r.peutTerminerOffre = 'true';
  if (!r.blocageOffre) r.blocageOffre = 'false';
  if (!r.statutInterneOffre) r.statutInterneOffre = 'active';
  if (!r.jourAnniversaire) r.jourAnniversaire = '—';

  const today = new Date().toLocaleDateString('fr-FR');
  if (!r.dateCreationIdentite) r.dateCreationIdentite = today;
  if (!r.dateModifIdentite) r.dateModifIdentite = today;
  if (!r.dateCreationCompte) r.dateCreationCompte = today;
  if (!r.dateCreationContact) r.dateCreationContact = today;
  if (!r.dateModifContact) r.dateModifContact = today;
  if (!r.dateCreationOffre) r.dateCreationOffre = today;
  if (!r.dateModifOffre) r.dateModifOffre = today;

  if (!r.login && (r.prenom || r.nom)) {
    r.login = ((r.prenom||'').substring(0,1) + (r.nom||'')).toLowerCase().replace(/[^a-z]/g,'') + Math.floor(Math.random()*9000+1000);
    r.loginCompte = r.login;
  }

  if (!r.idAdresse) r.idAdresse = Math.floor(Math.random()*90000000+10000000).toString();
  if (!r.idAdresseSubscription) r.idAdresseSubscription = Math.floor(Math.random()*9000000+1000000).toString();

  return r;
}

function guessName(lines, r) {
  const skip = [r.email, r.mobile, r.telephone, r.codePostal, r.ville, r.numeroVoie]
    .filter(Boolean).map(s => s.toLowerCase());
  const nameRx = /^[A-Za-zÀ-ÿ\s\-']{2,40}$/;
  const skipRx = /[@\d:\/\.\\]/;

  const cands = lines.filter(l => {
    const c = l.replace(/^[^:]+:\s*/,'').trim();
    return nameRx.test(c) && !skipRx.test(c) && !skip.some(s => c.toLowerCase() === s);
  });

  if (!cands.length) return { prenom: '', nom: '' };
  const parts = cands[0].replace(/^[^:]+:\s*/,'').trim().split(/\s+/);
  if (parts.length >= 2) {
    const hasCaps = parts.find(p => p === p.toUpperCase() && p.length > 1 && /[A-Z]/.test(p));
    if (hasCaps) {
      const nomIdx = parts.findIndex(p => p === p.toUpperCase() && p.length > 1 && /[A-Z]/.test(p));
      const prenomParts = parts.filter((_, i) => i !== nomIdx);
      return { nom: hasCaps, prenom: capitalizeName(prenomParts.join(' ')) };
    }
    return { prenom: capitalizeName(parts[0]), nom: parts.slice(1).join(' ').toUpperCase() };
  }
  return { prenom: '', nom: parts[0].toUpperCase() };
}

// ══════════════════════════════════════════
//  RENDER
// ══════════════════════════════════════════

function renderAll() {
  if (records.length === 0) { showSearch(); return; }
  showResults();
  renderChips();
  renderRecord(currentIdx);
  renderMeta();
}

function showSearch() { if (typeof navigate === 'function') navigate('search'); }
function showResults() { if (typeof navigate === 'function') navigate('results'); }

function renderChips() {
  const row = document.getElementById('chipRow');
  if (!records.length) { row.innerHTML = ''; return; }
  const r = records[currentIdx];
  row.innerHTML = r.email ? `
    <div class="chip">
      <span class="chip-label">Email</span>
      <span class="chip-value">${truncate(r.email, 26)}</span>
      <span class="chip-count">${records.length}</span>
    </div>` : '';
}

function renderMeta() {
  const el = document.getElementById('resultMeta');
  if (!el || !records.length) return;
  const t = (performance.now() / 1000).toFixed(3);
  el.textContent = `⏱ ${t} secondes   Résultats : ${records.length} sur ${records.length}`;
}

function renderRecord(idx) {
  currentIdx = Math.max(0, Math.min(idx, records.length - 1));
  const r = records[currentIdx];
  const sections = document.getElementById('sections');
  if (!sections) return;
  sections.innerHTML = '';

  // ── ÉTAT CIVIL ──
  sections.appendChild(buildSection('État Civil', [
    r.sexe           ? ['Sexe', r.sexe, ''] : null,
    r.prenom         ? ['Prénom', r.prenom, 'highlight'] : null,
    r.nom            ? ['Nom', r.nom, 'highlight'] : null,
    r.dateNaissance  ? ['Date de naissance', r.dateNaissance, ''] : null,
    r.villeNaissance ? ['Ville de naissance', r.villeNaissance, ''] : null,
    r.paysNaissance  ? ['Pays de naissance', r.paysNaissance, ''] : null,
    r.deptNaissance  ? ['Département de naissance', r.deptNaissance, ''] : null,
    ['Statut de l\'identité', r.statutIdentite, r.statutIdentite === 'actif' ? 'green' : 'orange'],
    ['Date de création', r.dateCreationIdentite, 'muted'],
    ['Date de modification', r.dateModifIdentite, 'muted'],
  ]));

  // ── CONTACT ──
  sections.appendChild(buildSection('Contact', [
    r.mobile          ? ['Mobile', r.mobile, ''] : null,
    r.telephone       ? ['Téléphone', r.telephone, ''] : null,
    r.numeroContact   ? ['Numéro contact', r.numeroContact, ''] : null,
    r.email           ? ['Email', r.email, 'highlight'] : null,
    r.email           ? ['Email Subscription', r.emailSubscription, 'highlight'] : null,
    ['Date création contact', r.dateCreationContact, 'muted'],
    ['Date modif contact', r.dateModifContact, 'muted'],
  ]));

  // ── ADRESSE ──
  sections.appendChild(buildSection('Adresse', [
    r.numeroVoie           ? ['Numéro et voie', r.numeroVoie, ''] : null,
    r.complementAdresse    ? ['Complément', r.complementAdresse, 'muted'] : null,
    r.codePostal           ? ['Code postal', r.codePostal, ''] : null,
    r.ville                ? ['Ville', r.ville, ''] : null,
    r.idAdresse            ? ['ID adresse', r.idAdresse, 'muted'] : null,
    r.idAdresseSubscription? ['ID adresse Sub.', r.idAdresseSubscription, 'muted'] : null,
    r.cpSubscription       ? ['CP Subscription', r.cpSubscription, 'muted'] : null,
    r.nomRueSubscription   ? ['Rue Subscription', r.nomRueSubscription, 'muted'] : null,
  ]));

  // ── IPs ──
  if (r.ips && r.ips.length > 0) {
    sections.appendChild(buildSection('Adresses IP', r.ips.map((ip, i) => [`IP ${i+1}`, ip, 'purple'])));
  }

  // ── COMPTES NUMÉRIQUES ──
  const hasDigital = r.discordId || r.discordUsername || r.liveId || r.licenseKey || r.loginCompte || r.login;
  if (hasDigital) {
    sections.appendChild(buildSection('Comptes & Identifiants', [
      r.loginCompte   ? ['Login compte', r.loginCompte, 'purple'] : null,
      r.login         ? ['Login', r.login, 'purple'] : null,
      r.discordId     ? ['Discord ID', r.discordId, 'highlight'] : null,
      r.discordUsername ? ['Discord Username', r.discordUsername, 'highlight'] : null,
      r.liveId        ? ['Live ID', r.liveId, 'highlight'] : null,
      r.licenseKey    ? ['Clé de licence', truncate(r.licenseKey, 40), 'muted'] : null,
    ]));
  }

  // ── INFORMATIONS COMPTE ──
  sections.appendChild(buildSection('Informations du Compte', [
    ['Date création compte', r.dateCreationCompte, 'muted'],
    ['Peut être associé', r.peutEtreAssocie, r.peutEtreAssocie === 'true' ? 'green' : 'orange'],
    r.enfants         ? ['Enfants', r.enfants, 'muted'] : null,
    ['A un enfant actif', r.enfantActif, r.enfantActif === 'true' ? 'green' : 'muted'],
  ]));

  // ── OFFRE ──
  sections.appendChild(buildSection('Détails de l\'Offre', [
    ['Jour anniversaire offre', r.jourAnniversaire, ''],
    ['Peut terminer l\'offre', r.peutTerminerOffre, r.peutTerminerOffre === 'true' ? 'green' : 'orange'],
    ['Date création offre', r.dateCreationOffre, 'muted'],
    ['Blocage offre', r.blocageOffre, r.blocageOffre === 'true' ? 'orange' : 'muted'],
    ['Statut interne offre', r.statutInterneOffre, r.statutInterneOffre === 'active' ? 'green' : 'orange'],
    ['Date modif offre', r.dateModifOffre, 'muted'],
  ]));

  // ── DIPLÔMES / EMPLOIS ──
  if (r.diplomes && r.diplomes.length) {
    sections.appendChild(buildSection('Diplômes & Formations',
      r.diplomes.map((d, i) => [`Formation ${i+1}`, d, ''])
    ));
  }
  if (r.emplois && r.emplois.length) {
    sections.appendChild(buildSection('Emplois',
      r.emplois.map((e, i) => [`Emploi ${i+1}`, e, ''])
    ));
  }

  // ── RÉSEAU FAMILIAL ──
  if (r._familyMembers && r._familyMembers.length > 0) {
    renderFamilySection(sections, r._familyMembers);
  }

  // Compteur
  const counter = document.getElementById('recordCounter');
  if (counter) counter.textContent = `${currentIdx + 1} / ${records.length}`;
}

function renderFamilySection(sections, members) {
  const block = document.createElement('div');
  block.className = 'section-block';
  const title = document.createElement('div');
  title.className = 'section-title';
  title.textContent = '👥 Réseau Familial';
  block.appendChild(title);

  for (const m of members) {
    const card = document.createElement('div');
    card.className = 'family-card';

    const header = document.createElement('div');
    header.className = 'family-header';
    const relBadge = document.createElement('span');
    relBadge.className = 'family-relation';
    relBadge.textContent = m.relation;
    const nameEl = document.createElement('span');
    nameEl.className = 'family-name';
    nameEl.textContent = [m.prenom, m.nom].filter(Boolean).join(' ') || '—';
    header.appendChild(relBadge);
    header.appendChild(nameEl);
    card.appendChild(header);

    const rows = [];
    if (m.adresse) rows.push(['📍 Adresse', m.adresse]);
    if (m.emploi) rows.push(['💼 Emploi', m.emploi]);
    if (m.diplomes.length) m.diplomes.forEach((d, i) => rows.push([`🎓 Diplôme ${i+1}`, d]));
    if (m.anciensTaffs.length) m.anciensTaffs.forEach((t, i) => rows.push([`📋 Ancien poste ${i+1}`, t]));
    if (m.infos.length) m.infos.forEach(info => rows.push(['ℹ️', info]));

    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'field-row';
      row.innerHTML = `<div class="field-key">${k}</div><div class="field-val">${v}</div>`;
      card.appendChild(row);
    }

    block.appendChild(card);
  }

  sections.appendChild(block);
}

function buildSection(title, fields) {
  const div = document.createElement('div');
  div.className = 'section-block';
  const t = document.createElement('div');
  t.className = 'section-title';
  t.textContent = title;
  div.appendChild(t);
  let hasContent = false;
  for (const f of fields) {
    if (!f) continue;
    const [key, val, cls] = f;
    if (!val && val !== '0') continue;
    hasContent = true;
    const row = document.createElement('div');
    row.className = 'field-row';
    const k = document.createElement('div');
    k.className = 'field-key';
    k.textContent = key;
    const v = document.createElement('div');
    v.className = 'field-val' + (cls ? ` ${cls}` : '');
    v.textContent = val;
    row.appendChild(k);
    row.appendChild(v);
    div.appendChild(row);
  }
  if (!hasContent) {
    const empty = document.createElement('div');
    empty.className = 'field-row';
    empty.innerHTML = '<div class="field-val muted" style="font-style:italic">Aucune donnée disponible</div>';
    div.appendChild(empty);
  }
  return div;
}

// ══════════════════════════════════════════
//  ACTIONS
// ══════════════════════════════════════════

function doSearch() {
  const raw = document.getElementById('mainInput')?.value?.trim();
  if (!raw) { showToast('Aucun texte à analyser', 'err'); return; }
  const parsed = parseText(raw);
  if (parsed.length === 0) { showToast('Aucune donnée détectée. Vérifie le format.', 'err'); return; }
  records = parsed;
  currentIdx = 0;
  localStorage.setItem('loyal_records', JSON.stringify(records));
  renderAll();
  showToast(`${records.length} enregistrement(s) chargé(s)`, 'ok');
}

function handleFileImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    document.getElementById('mainInput').value = ev.target.result;
    showToast(`Fichier chargé : ${file.name}`, 'ok');
  };
  reader.readAsText(file);
}

function clearAll() {
  if (!confirm('Effacer tous les résultats ?')) return;
  records = [];
  localStorage.removeItem('loyal_records');
  if (typeof navigate === 'function') navigate('search');
  else showSearch();
  showToast('Résultats effacés', 'ok');
}

function copyRecord() {
  if (!records.length) return;
  const r = records[currentIdx];
  const lines = [
    r.prenom      ? `Prénom     : ${r.prenom}` : null,
    r.nom         ? `Nom        : ${r.nom}` : null,
    r.email       ? `Email      : ${r.email}` : null,
    (r.mobile||r.telephone) ? `Téléphone  : ${r.mobile||r.telephone}` : null,
    r.numeroVoie  ? `Adresse    : ${r.numeroVoie}` : null,
    r.codePostal  ? `CP         : ${r.codePostal}` : null,
    r.ville       ? `Ville      : ${r.ville}` : null,
    r.ips.length  ? `IPs        : ${r.ips.join(', ')}` : null,
    r.discordId   ? `Discord ID : ${r.discordId}` : null,
  ].filter(Boolean);
  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => showToast('Copié dans le presse-papier ✓', 'ok'))
    .catch(() => showToast('Erreur de copie', 'err'));
}

function exportCSV() {
  if (!records.length) { showToast('Aucune donnée', 'err'); return; }
  const keys = ['prenom','nom','sexe','dateNaissance','email','mobile','telephone','numeroVoie','codePostal','ville','login','discordId'];
  const headers = ['Prénom','Nom','Sexe','Date Naissance','Email','Mobile','Téléphone','Adresse','CP','Ville','Login','Discord ID'];
  const rows = records.map(r => keys.map(k => {
    const val = Array.isArray(r[k]) ? r[k].join(';') : (r[k]||'');
    return `"${val.replace(/"/g,'""')}"`;
  }));
  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  download('clients.csv', csv, 'text/csv');
  showToast('Export CSV téléchargé', 'ok');
}

function exportTXT() {
  if (!records.length) { showToast('Aucune donnée', 'err'); return; }
  const txt = records.map((r, i) => {
    const lines = [
      `── ENREGISTREMENT #${i+1} ──`,
      `Prénom    : ${r.prenom||'—'}`,
      `Nom       : ${r.nom||'—'}`,
      `Email     : ${r.email||'—'}`,
      `Mobile    : ${r.mobile||'—'}`,
      `Téléphone : ${r.telephone||'—'}`,
      `Adresse   : ${r.numeroVoie||'—'}`,
      `CP / Ville: ${r.codePostal} ${r.ville}`.trim(),
      `Login     : ${r.login||'—'}`,
    ];
    if (r.ips.length) lines.push(`IPs       : ${r.ips.join(', ')}`);
    if (r.discordId) lines.push(`Discord   : ${r.discordId}`);
    if (r._familyMembers && r._familyMembers.length) {
      lines.push('');
      lines.push('── RÉSEAU FAMILIAL ──');
      r._familyMembers.forEach(m => {
        lines.push(`${m.relation}: ${[m.prenom, m.nom].filter(Boolean).join(' ')}`);
        if (m.adresse) lines.push(`  Adresse : ${m.adresse}`);
        if (m.emploi) lines.push(`  Emploi  : ${m.emploi}`);
      });
    }
    return lines.join('\n');
  }).join('\n\n');
  download('clients.txt', txt, 'text/plain');
  showToast('Export TXT téléchargé', 'ok');
}

function download(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
}

function prevRecord() {
  if (currentIdx > 0) { currentIdx--; renderRecord(currentIdx); renderChips(); renderResultsList(); }
}
function nextRecord() {
  if (currentIdx < records.length - 1) { currentIdx++; renderRecord(currentIdx); renderChips(); renderResultsList(); }
}
function renderResultsList() {
  const counter = document.getElementById('recordCounter');
  if (counter) counter.textContent = `${currentIdx + 1} / ${records.length}`;
}

function setView(v) {
  currentView = v;
  ['dsc','tlg','kk'].forEach(id => {
    document.getElementById('vbtn-'+id)?.classList.toggle('active', id === v);
  });
}

let _tt;
function showToast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = `toast ${type} show`;
  clearTimeout(_tt);
  _tt = setTimeout(() => t.classList.remove('show'), 2800);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'TEXTAREA') {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doSearch();
    return;
  }
  if (e.key === 'ArrowLeft') prevRecord();
  if (e.key === 'ArrowRight') nextRecord();
});

document.addEventListener('DOMContentLoaded', () => {
  if (records.length) renderAll();
});
