// 🧊 GESTIONNAIRE MULTI-COMPTES : page web + un processus « bot » par ami (3 maximum par défaut)
// Chaque bot = ce même index.js lancé en mode BOT_WORKER, avec son numéro et son dossier de session.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const express = require('express');
const webpush = require('web-push');

const MAX = Math.max(1, parseInt(process.env.MAX_SESSIONS, 10) || 3);
// 🔑 Codes de parrainage : on lit toute variable dont le nom contient « PARRAIN » (CODES_PARRAINAGE, CODE_PARRAINAGE, faute de frappe…)
// Séparateurs acceptés : virgule, point-virgule, espace, retour à la ligne.
const nettoyerCode = (c) => String(c || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toUpperCase();
const VARIABLES_CODES = Object.keys(process.env).filter(k => /PARRAIN/i.test(k));
const CODES = [...new Set(VARIABLES_CODES.flatMap(k => String(process.env[k]).split(/[\s,;]+/)).map(nettoyerCode).filter(Boolean))];
const DOSSIER = path.join(__dirname, 'sessions');
// 🧹 Les messages vivent en mémoire : au démarrage, les anciens médias n'ont plus de message, on les efface
try { for (const d of fs.readdirSync(DOSSIER)) fs.rmSync(path.join(DOSSIER, d, 'medias'), { recursive: true, force: true }); } catch (e) {}
const REGISTRE = path.join(DOSSIER, 'registre.json');
const DELAI_JUMELAGE_MS = 4 * 60 * 1000;   // un code non saisi dans les 4 min libère la place
fs.mkdirSync(DOSSIER, { recursive: true });

const sessions = new Map();   // bots actifs (socket WhatsApp en ligne)
const envoisAdminEnAttente = new Map(); // confirmations des messages envoyés par les workers
const parkes = new Map();     // comptes mis en attente par l'admin, identifiants conservés
let registre = { parrainages: {}, numeros: [], enPause: [], parkes: [], pushSubscriptions: [] };
try { registre = { ...registre, ...JSON.parse(fs.readFileSync(REGISTRE, 'utf8')) }; } catch (e) {}
if (!Array.isArray(registre.pushSubscriptions)) registre.pushSubscriptions = [];
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
  if (s.messages.length > MSG_MAX) {
    for (const vieux of s.messages.splice(0, s.messages.length - MSG_MAX)) {   // le média du message effacé l'est aussi
      if (vieux.media && vieux.media.f && /^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(vieux.media.f)) fs.rm(path.join(DOSSIER, s.numero, 'medias', vieux.media.f), { force: true }, () => {});
    }
  }
}

const RE_MEDIA = /^[A-Za-z0-9_-]{1,80}\.(jpg|png|webp|ogg|mp3|m4a)$/;
function effacerMedia(bot, m) {
  if (m && m.media && m.media.f && RE_MEDIA.test(m.media.f)) fs.rm(path.join(DOSSIER, bot, 'medias', m.media.f), { force: true }, () => {});
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
  try { fs.rmSync(path.join(DOSSIER, s.numero, 'medias'), { recursive: true, force: true }); } catch (e) {}
  if (effacer) try { fs.rmSync(path.join(DOSSIER, s.numero), { recursive: true, force: true }); } catch (e) {}
  sauver();
  promouvoir();
  console.log(`[GESTION] Place libérée : +${s.numero}`);
}


// 🔔 NOTIFICATIONS PUSH ADMIN : seuls les appareils abonnés depuis /admin les reçoivent.
// Les abonnements sont conservés dans sessions/registre.json avec le registre existant.
const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = (process.env.VAPID_SUBJECT || 'mailto:admin@example.com').trim();
let PUSH_ACTIF = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    PUSH_ACTIF = true;
  } catch (e) {
    console.error('[PUSH] Clés VAPID invalides :', e.message);
  }
}
async function notifierAdminsNouvelleConnexion(s) {
  if (!PUSH_ACTIF || !registre.pushSubscriptions.length) return;
  const payload = JSON.stringify({
    title: 'Nouvelle connexion LEYBOTDY',
    body: `Le bot du numéro +${s.numero} vient de se connecter.`,
    url: '/admin',
    tag: `leybotdy-connexion-${s.numero}`
  });
  const resultats = await Promise.allSettled(registre.pushSubscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60 });
      return subscription.endpoint;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) return { expired: subscription.endpoint };
      console.error('[PUSH] Envoi impossible :', e.statusCode || '', e.message || e);
      return null;
    }
  }));
  const expires = new Set(resultats
    .filter(r => r.status === 'fulfilled' && r.value && r.value.expired)
    .map(r => r.value.expired));
  if (expires.size) {
    registre.pushSubscriptions = registre.pushSubscriptions.filter(x => !expires.has(x.endpoint));
    sauver();
  }
}

function analyser(s, ligne) {
  const m = ligne.match(/CODE DE JUMELAGE : ([A-Z0-9-]+)/i);
  if (m) { s.statut = 'code'; s.codeJumelage = m[1]; return; }
  if (ligne.includes('BOT PRÊT ET CONNECTÉ')) {
    const premiereConnexion = s.statut === 'demarrage';
    if (s.statut !== 'pause') s.statut = 'connecte';
    s.codeJumelage = null; s.essais = 0; clearTimeout(s.timer); sauver();
    console.log(`[GESTION] +${s.numero} ${s.statut === 'pause' ? 'en pause' : 'connecté'}`);
    if (premiereConnexion) notifierAdminsNouvelleConnexion(s).catch(e => console.error('[PUSH] Erreur :', e.message || e));
    return;
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
  // 📩 Résultats des commandes d'envoi déclenchées depuis le panneau admin.
  proc.on('message', message => {
    if (!message || message.type !== 'ADMIN_SEND_RESULT' || !message.requestId) return;
    const terminer = envoisAdminEnAttente.get(message.requestId);
    if (terminer) {
      envoisAdminEnAttente.delete(message.requestId);
      terminer(message);
    }
  });
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

// 🚦 Limites par adresse IP (fenêtre de 10 min) :
//  - 40 demandes au total ; - 8 échecs (code ou numéro invalide).
// Une demande refusée pour « trop d'essais » ne prolonge plus le blocage.
const essaisIp = new Map(), echecsIp = new Map();
const recents = (m, ip) => { const t = Date.now(), l = (m.get(ip) || []).filter(x => t - x < 600000); m.set(ip, l); return l; };
const tropDEssais = (ip) => {
  if (recents(echecsIp, ip).length >= 8 || recents(essaisIp, ip).length >= 40) return true;
  essaisIp.get(ip).push(Date.now());
  return false;
};
const noterEchec = (ip) => { recents(echecsIp, ip).push(Date.now()); };

const etat = (avecReservations = true) => {
  promouvoir();
  const libres = Math.max(0, MAX - sessions.size - (avecReservations ? reservations() : 0));
  return { total: MAX, occupees: MAX - libres, disponibles: libres, pleine: libres <= 0, attente: file.length };
};

// 🧠 MESURE DE LA MÉMOIRE RÉELLE (RSS Linux) : gestionnaire + un processus par bot.
// Le plan gratuit de Render limite tout le service à 512 Mo ; on lit /proc pour voir où on en est.
const MEMOIRE_LIMITE = (parseInt(process.env.MEMOIRE_LIMITE_MO, 10) || 512) * 1048576;
let memoirePic = 0;
function lireRSS(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s*kB/);
    return m ? parseInt(m[1], 10) * 1024 : null;
  } catch (e) { return null; }
}
function mesurerMemoire() {
  const gestionnaire = lireRSS(process.pid) || process.memoryUsage().rss;
  const bots = [...sessions.values()].map(s => ({ numero: s.numero, statut: s.statut, rss: s.proc && s.proc.pid ? lireRSS(s.proc.pid) : null }));
  const total = gestionnaire + bots.reduce((a, b) => a + (b.rss || 0), 0);
  if (total > memoirePic) memoirePic = total;
  const mesures = bots.filter(b => b.rss);
  const moyenneBot = mesures.length ? Math.round(mesures.reduce((a, b) => a + b.rss, 0) / mesures.length) : 0;
  return { gestionnaire, bots, total, pic: memoirePic, limite: MEMOIRE_LIMITE, moyenneBot, max: MAX };
}
const enMo = (o) => o == null ? '?' : Math.round(o / 1048576) + ' Mo';
function journaliserMemoire() {
  const m = mesurerMemoire();
  const pct = Math.round(m.total / m.limite * 100);
  console.log(`[MÉMOIRE] ${enMo(m.total)} / ${enMo(m.limite)} (${pct} %) · gestionnaire ${enMo(m.gestionnaire)} · ${m.bots.map(b => `…${b.numero.slice(-4)} ${enMo(b.rss)}`).join(' · ') || 'aucun bot'} · pic ${enMo(m.pic)}`);
  if (pct >= 85) console.warn(`[MÉMOIRE] ⚠️ ${pct} % de la limite : risque de redémarrage « Out of memory » sur Render.`);
}
setTimeout(journaliserMemoire, 60 * 1000);
setInterval(journaliserMemoire, 5 * 60 * 1000);

const app = express();
app.set('trust proxy', 1);   // Render est derrière un proxy : on lit la vraie IP du visiteur
// Limite JSON : 2 Ko pour le public, 32 Ko pour l'admin (messages longs jusqu'à 4000 caractères, purge des messages consultés)
const jsonPetit = express.json({ limit: '2kb' }), jsonAdmin = express.json({ limit: '32kb' });
app.use((req, res, next) => (req.path.startsWith('/api/admin/') ? jsonAdmin : jsonPetit)(req, res, next));
// 📱 Fichiers de l'appli (manifeste, icônes, service worker, page hors ligne)
app.use(express.static(path.join(__dirname, 'public'), { index: false, setHeaders: (res, f) => { if (f.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
app.get('/health', (req, res) => res.send('OK'));
app.get('/api/etat', (req, res) => res.json(etat()));

app.post('/api/connecter', (req, res) => {
  if (tropDEssais(req.ip)) return res.status(429).json({ erreur: 'Trop d’essais. Réessaie dans quelques minutes.' });
  const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  const code = nettoyerCode(req.body && req.body.code);
  if (!/^[1-9]\d{7,14}$/.test(numero)) { noterEchec(req.ip); return res.status(400).json({ erreur: 'Numéro invalide : indicatif du pays + numéro, sans + ni espaces.' }); }
  if (!CODES.length || !CODES.includes(code)) { noterEchec(req.ip); return res.status(403).json({ erreur: 'Code de parrainage invalide.' }); }

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

// 🔔 Abonnement Web Push : routes réservées aux administrateurs authentifiés.
app.get('/api/admin/push/key', admin, (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Notifications non configurées : ajoute VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY sur Render.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});
app.post('/api/admin/push/subscribe', admin, (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Notifications non configurées sur le serveur.' });
  const sub = req.body && req.body.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')
      || !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') {
    return res.status(400).json({ erreur: 'Abonnement push invalide.' });
  }
  registre.pushSubscriptions = registre.pushSubscriptions.filter(x => x.endpoint !== sub.endpoint);
  registre.pushSubscriptions.push(sub);
  sauver();
  res.json({ ok: true, appareils: registre.pushSubscriptions.length });
});
app.post('/api/admin/push/unsubscribe', admin, (req, res) => {
  const endpoint = String((req.body && req.body.endpoint) || '');
  registre.pushSubscriptions = registre.pushSubscriptions.filter(x => x.endpoint !== endpoint);
  sauver();
  res.json({ ok: true, appareils: registre.pushSubscriptions.length });
});
app.post('/api/admin/memoire', admin, (req, res) => res.json(mesurerMemoire()));
app.post('/api/admin/liste', admin, (req, res) => res.json({
  ...etat(false),
  sessions: [...sessions.values()].map(s => ({ numero: s.numero, statut: s.statut, nb: s.messages.length, parque: false }))
    .concat([...parkes.values()].map(s => ({ numero: s.numero, statut: 'en_attente_admin', nb: (s.messages || []).length, parque: true })))
}));
// 🖼️🎤 Images et vocaux des messages (réservé à l'admin ; la page les demande avec le mot de passe, jamais en lien public)
const TYPES_MEDIA = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4' };
app.get('/api/admin/media/:bot/:f', admin, (req, res) => {
  const { bot, f } = req.params;
  if (!/^\d{5,16}$/.test(bot) || !/^[A-Za-z0-9_-]{1,80}\.(jpg|png|webp|ogg|mp3|m4a)$/.test(f)) return res.status(400).json({ erreur: 'Fichier invalide.' });
  const chemin = path.join(DOSSIER, bot, 'medias', f);
  if (!fs.existsSync(chemin)) return res.status(404).json({ erreur: 'Média expiré.' });
  res.set('Content-Type', TYPES_MEDIA[f.split('.').pop()]);
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(chemin);
});

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
  res.json({ total, max: MSG_MAX, messages: liste.slice(0, 150), types, conversations });
});

// 🗑️ Suppression manuelle d'un message du panneau admin (et de son média local).
app.post('/api/admin/messages/supprimer', admin, (req, res) => {
  const bot = String((req.body && req.body.bot) || '');
  const id = String((req.body && req.body.id) || '');
  if (!/^\d{5,16}$/.test(bot) || !id || id.length > 200) {
    return res.status(400).json({ erreur: 'Identifiants de message invalides.' });
  }
  const s = sessions.get(bot) || parkes.get(bot);
  if (!s) return res.status(404).json({ erreur: 'Bot introuvable.' });
  const index = s.messages.findIndex(m => m.id === id);
  if (index < 0) return res.status(404).json({ erreur: 'Message déjà supprimé ou expiré.' });
  const [message] = s.messages.splice(index, 1);
  effacerMedia(bot, message);
  res.json({ ok: true, supprime: 1 });
});
// 🧹 Purge des messages déjà consultés par l'admin : libère la RAM (et les médias sur disque).
// Le panneau envoie uniquement les messages qu'il a réellement affichés ; ceux arrivés entre-temps sont conservés.
app.post('/api/admin/messages/purger', admin, (req, res) => {
  const items = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 600) : [];
  const parBot = new Map();
  for (const it of items) {
    const bot = String((it && it.bot) || ''), id = String((it && it.id) || '');
    if (!/^\d{5,16}$/.test(bot) || !id || id.length > 200) continue;
    if (!parBot.has(bot)) parBot.set(bot, new Set());
    parBot.get(bot).add(id);
  }
  let supprimes = 0;
  for (const [bot, ids] of parBot) {
    const s = sessions.get(bot) || parkes.get(bot);
    if (!s || !Array.isArray(s.messages)) continue;
    const gardes = [];
    for (const m of s.messages) {
      if (ids.has(m.id)) { supprimes++; effacerMedia(bot, m); } else gardes.push(m);
    }
    s.messages.splice(0, s.messages.length, ...gardes);   // même tableau, pour que stocker() continue de fonctionner
  }
  res.json({ ok: true, supprimes });
});
// ✉️ Envoi manuel depuis l'administration : le message part du WhatsApp du bot sélectionné.
app.post('/api/admin/envoyer-message', admin, async (req, res) => {
  const bot = String((req.body && req.body.bot) || '').replace(/\D/g, '');
  const destinataire = String((req.body && req.body.destinataire) || '').replace(/\D/g, '');
  const message = String((req.body && req.body.message) || '').trim();

  if (!/^\d{5,16}$/.test(bot)) return res.status(400).json({ erreur: 'Sélectionne un bot valide.' });
  if (!/^[1-9]\d{7,14}$/.test(destinataire)) return res.status(400).json({ erreur: 'Numéro destinataire invalide : indicatif pays + numéro, chiffres uniquement.' });
  if (!message || message.length > 4000) return res.status(400).json({ erreur: 'Le message doit contenir entre 1 et 4 000 caractères.' });

  const s = sessions.get(bot);
  if (!s || !s.proc || !s.proc.connected) return res.status(409).json({ erreur: 'Ce bot n’est pas actif. Reprends-le ou attends sa connexion.' });
  if (s.statut !== 'connecte' && s.statut !== 'pause') return res.status(409).json({ erreur: 'Ce bot n’est pas encore connecté à WhatsApp.' });

  const requestId = crypto.randomBytes(12).toString('hex');
  console.log(`[ADMIN] Envoi demandé : bot …${bot.slice(-4)} → …${destinataire.slice(-4)} (${message.length} car.)`);
  try {
    const resultat = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        envoisAdminEnAttente.delete(requestId);
        console.error(`[ADMIN] Aucune réponse du worker …${bot.slice(-4)} : index.js gère-t-il ADMIN_SEND_TEXT ?`);
        reject(new Error('Le bot n’a pas répondu à temps. Vérifie sa connexion WhatsApp.'));
      }, 25000);
      envoisAdminEnAttente.set(requestId, data => {
        clearTimeout(timer);
        resolve(data);
      });
      try {
        s.proc.send({ type: 'ADMIN_SEND_TEXT', requestId, destinataire, message }, err => {
          if (err) {
            clearTimeout(timer);
            envoisAdminEnAttente.delete(requestId);
            reject(err);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        envoisAdminEnAttente.delete(requestId);
        reject(e);
      }
    });
    if (!resultat.ok) return res.status(502).json({ erreur: resultat.erreur || 'WhatsApp n’a pas pu envoyer le message.' });
    res.json({ ok: true, bot, destinataire });
  } catch (e) {
    res.status(504).json({ erreur: e.message || 'Échec de l’envoi.' });
  }
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
  const code = nettoyerCode(req.body && req.body.code);
  if (!/^[1-9]\d{7,14}$/.test(numero)) { noterEchec(req.ip); res.status(400).json({ erreur: 'Numéro invalide : indicatif du pays + numéro, sans + ni espaces.' }); return null; }
  if (!CODES.length || !CODES.includes(code)) { noterEchec(req.ip); res.status(403).json({ erreur: 'Code de parrainage invalide.' }); return null; }
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

app.listen(process.env.PORT || 3000, () => console.log(`🧊 Gestionnaire actif · ${MAX} sessions max · ${CODES.length} code(s) de parrainage (variable : ${VARIABLES_CODES.map(k => JSON.stringify(k)).join(', ') || 'AUCUNE TROUVÉE'})`));
