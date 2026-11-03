// 🧊 GESTIONNAIRE MULTI-COMPTES : page web + un processus « bot » par ami (3 maximum par défaut)
// Chaque bot = ce même index.js lancé en mode BOT_WORKER, avec son numéro et son dossier de session.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const express = require('express');

const MAX = Math.max(1, parseInt(process.env.MAX_SESSIONS, 10) || 3);
const CODES = (process.env.CODES_PARRAINAGE || '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean);
const DOSSIER = path.join(__dirname, 'sessions');
const REGISTRE = path.join(DOSSIER, 'registre.json');
const DELAI_JUMELAGE_MS = 4 * 60 * 1000;   // un code non saisi dans les 4 min libère la place
fs.mkdirSync(DOSSIER, { recursive: true });

const sessions = new Map();   // bots actifs (socket WhatsApp en ligne)
const parkes = new Map();     // comptes mis en attente par l'admin, identifiants conservés
let registre = { parrainages: {}, numeros: [], enPause: [], parkes: [] };
try { registre = { ...registre, ...JSON.parse(fs.readFileSync(REGISTRE, 'utf8')) }; } catch (e) {}
const sauver = () => {
  registre.numeros = [...sessions.keys()];
  registre.enPause = [...sessions.values()].filter(s => s.statut === 'pause').map(s => s.numero);
  registre.parkes = [...parkes.keys()];
  try { fs.writeFileSync(REGISTRE, JSON.stringify(registre)); } catch (e) {}
};

// ⏳ FILE D'ATTENTE : quand c'est plein, on s'inscrit ; une place libérée est gardée 5 min pour le premier de la file
// 💬 Messages de chaque bot : 100 au maximum, quand un nouveau arrive le plus ancien est effacé (mémoire seulement)
const MSG_MAX = 100;
function stocker(s, m) {
  if (!m || !m.id || s.messages.some(x => x.id === m.id)) return;   // pas de doublon
  s.messages.push(m);
  if (s.messages.length > MSG_MAX) s.messages.splice(0, s.messages.length - MSG_MAX);
}

const FILE_MAX = 10, DELAI_TOUR_MS = 5 * 60 * 1000;
const file = [];   // { numero, parrainage, jeton, reserveJusquA }
const reservations = () => file.filter(f => f.reserveJusquA && f.reserveJusquA > Date.now()).length;
function promouvoir() {
  const t = Date.now();
  for (let i = file.length - 1; i >= 0; i--) if (file[i].reserveJusquA && file[i].reserveJusquA <= t) file.splice(i, 1);   // tour expiré
  let libres = MAX - sessions.size - reservations();
  for (const f of file) { if (libres <= 0) break; if (!f.reserveJusquA) { f.reserveJusquA = t + DELAI_TOUR_MS; libres--; } }
}
setInterval(promouvoir, 5000);

function liberer(s, effacer) {
  clearTimeout(s.timer);
  const proc = s.proc; s.proc = null;
  if (proc) { try { proc.kill('SIGTERM'); } catch (e) {} }
  sessions.delete(s.numero);
  if (effacer) try { fs.rmSync(path.join(DOSSIER, s.numero), { recursive: true, force: true }); } catch (e) {}
  sauver();
  promouvoir();
  console.log(`[GESTION] Place libérée : +${s.numero}`);
}

function analyser(s, ligne) {
  const m = ligne.match(/CODE DE JUMELAGE : ([A-Z0-9-]+)/i);
  if (m) { s.statut = 'code'; s.codeJumelage = m[1]; return; }
  if (ligne.includes('BOT PRÊT ET CONNECTÉ')) {
    if (s.statut !== 'pause') s.statut = 'connecte';
    s.codeJumelage = null; s.essais = 0; clearTimeout(s.timer); sauver();
    console.log(`[GESTION] +${s.numero} ${s.statut === 'pause' ? 'en pause' : 'connecté'}`); return;
  }
  if (/jumelage initial a échoué|Demande de code échouée|PHONE_NUMBER absent|Session réinitialisée/.test(ligne)) liberer(s, true);
}

function lancer(s) {
  const dir = path.join(DOSSIER, s.numero);
  fs.mkdirSync(dir, { recursive: true });
  const proc = spawn(process.execPath, ['--max-old-space-size=110', '--expose-gc', path.join(__dirname, 'index.js')], {
    env: { ...process.env, BOT_WORKER: '1', PHONE_NUMBER: s.numero, AUTH_DIR: dir, LOG_MESSAGES: process.env.LOG_MESSAGES || 'off', BOT_START_PAUSED: s.statut === 'pause' ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  s.proc = proc;
  // 📜 Tous les logs du bot sont renvoyés dans les logs Render, précédés des 4 derniers chiffres du numéro
  const etiquette = `[…${s.numero.slice(-4)}]`;
  for (const flux of [proc.stdout, proc.stderr]) readline.createInterface({ input: flux }).on('line', l => {
    if (l.startsWith('@@MSG@@')) { try { stocker(s, JSON.parse(l.slice(7))); } catch (e) {} return; }   // messages : page admin, pas les logs
    console.log(`${etiquette} ${l}`); analyser(s, l);
  });
  proc.on('exit', () => {
    if (s.proc !== proc) return;   // arrêt voulu
    s.proc = null;
    if (s.statut !== 'connecte' && s.statut !== 'reconnexion') return liberer(s, true);
    const etaitEnPause = s.statut === 'pause';
    s.statut = etaitEnPause ? 'pause' : 'reconnexion';
    if (++s.essais > 5) return liberer(s, false);
    setTimeout(() => { if (sessions.get(s.numero) === s) lancer(s); }, 5000 * s.essais);
  });
}

function creer(numero, parrainage, statut) {
  const s = { numero, parrainage, jeton: crypto.randomBytes(16).toString('hex'), statut, codeJumelage: null, proc: null, essais: 0, timer: null, messages: [] };
  sessions.set(numero, s);
  if (statut === 'demarrage') s.timer = setTimeout(() => { if (s.statut !== 'connecte') liberer(s, true); }, DELAI_JUMELAGE_MS);
  lancer(s);
  return s;
}

// Après un redémarrage : on restaure les sessions actives et les comptes parkés.
for (const numero of registre.numeros || []) {
  if (sessions.size < MAX && fs.existsSync(path.join(DOSSIER, numero, 'creds.json'))) {
    const statut = (registre.enPause || []).includes(numero) ? 'pause' : 'reconnexion';
    creer(numero, null, statut);
  }
}
for (const numero of registre.parkes || []) {
  if (fs.existsSync(path.join(DOSSIER, numero, 'creds.json'))) {
    parkes.set(numero, { numero, statut: 'en_attente_admin', messages: [] });
  }
}

// 🚦 limite : 6 demandes / 10 min / adresse IP
const essaisIp = new Map();
const tropDEssais = (ip) => {
  const t = Date.now(), l = (essaisIp.get(ip) || []).filter(x => t - x < 600000);
  l.push(t); essaisIp.set(ip, l);
  return l.length > 6;
};

const etat = (avecReservations = true) => {
  promouvoir();
  const libres = Math.max(0, MAX - sessions.size - (avecReservations ? reservations() : 0));
  return { total: MAX, occupees: MAX - libres, disponibles: libres, pleine: libres <= 0, attente: file.length };
};

const app = express();
app.use(express.json({ limit: '2kb' }));
// 📱 Fichiers de l'appli (manifeste, icônes, service worker, page hors ligne)
app.use(express.static(path.join(__dirname, 'public'), { index: false, setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/health', (req, res) => res.send('OK'));
app.get('/api/etat', (req, res) => res.json(etat()));

app.post('/api/connecter', (req, res) => {
  if (tropDEssais(req.ip)) return res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans quelques minutes.' });
  const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!/^[1-9]\d{7,14}$/.test(numero)) return res.status(400).json({ erreur: 'Numéro invalide : indicatif du pays + numéro, sans + ni espaces.' });
  if (!CODES.length || !CODES.includes(code)) return res.status(403).json({ erreur: 'Code de parrainage invalide.' });

  const existant = sessions.get(numero);
  if (existant) return res.json({ jeton: existant.jeton, statut: existant.statut, codeJumelage: existant.codeJumelage });
  if (parkes.has(numero)) return res.status(409).json({ erreur: 'Ce compte est conservé en attente par le propriétaire. Demande sa reprise depuis l’administration.' });
  promouvoir();
  const iFile = file.findIndex(f => f.numero === numero);
  const aSonTour = iFile >= 0 && file[iFile].reserveJusquA > Date.now();
  if (!aSonTour && MAX - sessions.size - reservations() <= 0) return res.status(409).json({ erreur: 'pleines', ...etat() });
  if (iFile >= 0) file.splice(iFile, 1);

  const s = creer(numero, code, 'demarrage');
  sauver();
  res.json({ jeton: s.jeton, statut: s.statut, codeJumelage: null });
});

app.get('/api/statut', (req, res) => {
  const s = [...sessions.values()].find(x => x.jeton === req.query.jeton);
  if (!s) return res.status(404).json({ statut: 'perdu' });
  res.json({ statut: s.statut, codeJumelage: s.codeJumelage });
});

// 🔐 ADMIN : réservé au propriétaire, protégé par le mot de passe de la variable ADMIN_MOT_DE_PASSE
const ADMIN_MDP = (process.env.ADMIN_MOT_DE_PASSE || '').trim();
const empreinte = (x) => crypto.createHash('sha256').update(String(x)).digest();
const echecsAdmin = new Map();
function admin(req, res, next) {
  if (!ADMIN_MDP) return res.status(503).json({ erreur: 'ADMIN_MOT_DE_PASSE n’est pas défini sur Render.' });
  const t = Date.now(), l = (echecsAdmin.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 8) return res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans 10 minutes.' });
  const ok = crypto.timingSafeEqual(empreinte(req.headers['x-admin-key'] || ''), empreinte(ADMIN_MDP));
  if (!ok) { l.push(t); echecsAdmin.set(req.ip, l); return res.status(401).json({ erreur: 'Mot de passe incorrect.' }); }
  next();
}
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.post('/api/admin/liste', admin, (req, res) => res.json({
  ...etat(false),
  sessions: [...sessions.values()].map(s => ({ numero: s.numero, statut: s.statut, nb: s.messages.length, parque: false }))
    .concat([...parkes.values()].map(s => ({ numero: s.numero, statut: 'en_attente_admin', nb: (s.messages || []).length, parque: true })))
}));
app.post('/api/admin/messages', admin, (req, res) => {
  const b = req.body || {};
  const voulus = Array.isArray(b.numeros) && b.numeros.length ? b.numeros.map(String) : null;   // aucun = tous les bots
  const q = String(b.q || '').trim().toLowerCase(), sens = b.sens, type = String(b.type || ''), conv = String(b.conv || '');
  let liste = [];
  for (const s of [...sessions.values(), ...parkes.values()]) {
    if (voulus && !voulus.includes(s.numero)) continue;
    for (const m of s.messages) liste.push({ ...m, bot: s.numero });
  }
  const total = liste.length, types = [...new Set(liste.map(m => m.type))];
  const conversations = [...new Set(liste.map(m => m.conv).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  liste = liste.filter(m => (sens !== 'recu' && sens !== 'envoye' || m.sens === sens) && (!type || m.type === type)
    && (!conv || m.conv === conv) && (!q || `${m.texte} ${m.de} ${m.conv} ${m.numero || ''}`.toLowerCase().includes(q)));
  liste.sort((a, c) => c.t - a.t);
  res.json({ total, max: MSG_MAX, messages: liste.slice(0, 100), types, conversations });
});
// Pause douce : garde le socket WhatsApp connecté, mais ignore les nouveaux messages.
app.post('/api/admin/pause', admin, (req, res) => {
  const s = sessions.get(String((req.body && req.body.numero) || ''));
  if (!s) return res.status(404).json({ erreur: 'Session active introuvable.' });
  if (s.statut === 'pause') return res.json({ ok: true, statut: 'pause' });
  s.statut = 'pause';
  try { if (s.proc && s.proc.connected) s.proc.send({ type: 'BOT_PAUSE' }); } catch (e) {}
  sauver();
  res.json({ ok: true, statut: 'pause' });
});

// Reprise d'un bot en pause ou d'un compte parké.
app.post('/api/admin/reprendre', admin, (req, res) => {
  const numero = String((req.body && req.body.numero) || '');
  const actif = sessions.get(numero);
  if (actif) {
    if (actif.statut === 'pause') {
      actif.statut = 'connecte';
      try { if (actif.proc && actif.proc.connected) actif.proc.send({ type: 'BOT_RESUME' }); } catch (e) {}
      sauver();
    }
    return res.json({ ok: true, statut: actif.statut });
  }
  const s = parkes.get(numero);
  if (!s) return res.status(404).json({ erreur: 'Compte en attente introuvable.' });
  if (sessions.size >= MAX) return res.status(409).json({ erreur: 'Toutes les places sont occupées. Mets un bot en pause/permutation ou libère une place.' });
  parkes.delete(numero);
  s.statut = 'reconnexion'; s.proc = null; s.essais = 0; s.timer = null;
  sessions.set(numero, s);
  lancer(s);
  sauver();
  res.json({ ok: true, statut: 'reconnexion' });
});

// Permutation : conserve les identifiants du compte actuel, met son worker hors ligne,
// puis démarre la première personne de la file dans la place libérée.
app.post('/api/admin/permuter', admin, (req, res) => {
  const numero = String((req.body && req.body.numero) || '');
  const s = sessions.get(numero);
  if (!s) return res.status(404).json({ erreur: 'Session active introuvable.' });
  const proc = s.proc;
  s.proc = null;
  if (proc) { try { proc.kill('SIGTERM'); } catch (e) {} }
  sessions.delete(numero);
  s.statut = 'en_attente_admin';
  parkes.set(numero, s); // surtout ne pas effacer sessions/<numero> : le jumelage est conservé
  promouvoir();
  const suivant = file.shift();
  let nouveau = null;
  if (suivant) nouveau = creer(suivant.numero, suivant.parrainage, 'demarrage');
  sauver(); promouvoir();
  res.json({ ok: true, parkes: numero, remplacePar: nouveau ? nouveau.numero : null, ...etat(false) });
});

app.post('/api/admin/deconnecter', admin, (req, res) => {
  const numero = String((req.body && req.body.numero) || '');
  const s = sessions.get(numero);
  if (s) {
    liberer(s, true);
  } else if (parkes.has(numero)) {
    parkes.delete(numero);
    try { fs.rmSync(path.join(DOSSIER, numero), { recursive: true, force: true }); } catch (e) {}
    sauver();
  } else {
    return res.status(404).json({ erreur: 'Session introuvable.' });
  }
  res.json({ ok: true, ...etat(false) });
});

function lireDemande(req, res) {
  if (tropDEssais(req.ip)) { res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans quelques minutes.' }); return null; }
  const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  const code = String((req.body && req.body.code) || '').trim().toUpperCase();
  if (!/^[1-9]\d{7,14}$/.test(numero)) { res.status(400).json({ erreur: 'Numéro invalide : indicatif du pays + numéro, sans + ni espaces.' }); return null; }
  if (!CODES.length || !CODES.includes(code)) { res.status(403).json({ erreur: 'Code de parrainage invalide.' }); return null; }
  return { numero, code };
}
app.post('/api/file/rejoindre', (req, res) => {
  const d = lireDemande(req, res); if (!d) return;
  promouvoir();
  if (sessions.has(d.numero)) return res.status(409).json({ erreur: 'Ton bot est déjà connecté.' });
  if (parkes.has(d.numero)) return res.status(409).json({ erreur: 'Ce compte est déjà conservé en attente par le propriétaire.' });
  let f = file.find(x => x.numero === d.numero);
  if (!f) {
    if (file.length >= FILE_MAX) return res.status(409).json({ erreur: 'La file d’attente est pleine. Reviens plus tard.' });
    f = { numero: d.numero, parrainage: d.code, jeton: crypto.randomBytes(16).toString('hex'), reserveJusquA: null };
    file.push(f); promouvoir();
  }
  res.json({ jeton: f.jeton });
});
app.get('/api/file/statut', (req, res) => {
  promouvoir();
  const i = file.findIndex(x => x.jeton === req.query.jeton);
  if (i < 0) return res.status(404).json({ statut: 'perdu' });
  const f = file[i], tour = !!(f.reserveJusquA && f.reserveJusquA > Date.now());
  res.json({ position: i + 1, taille: file.length, tonTour: tour, restant: tour ? Math.ceil((f.reserveJusquA - Date.now()) / 1000) : 0 });
});
app.post('/api/file/quitter', (req, res) => {
  const i = file.findIndex(x => x.jeton === (req.body && req.body.jeton));
  if (i >= 0) file.splice(i, 1);
  promouvoir();
  res.json({ ok: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const arreter = () => { for (const s of sessions.values()) { const p = s.proc; s.proc = null; try { p && p.kill('SIGTERM'); } catch (e) {} } process.exit(0); };
process.once('SIGTERM', arreter); process.once('SIGINT', arreter);

app.listen(process.env.PORT || 3000, () => console.log(`🧊 Gestionnaire actif · ${MAX} sessions max · ${CODES.length} code(s) de parrainage`));
