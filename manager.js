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
if (!registre.chatPush || typeof registre.chatPush !== 'object' || Array.isArray(registre.chatPush)) registre.chatPush = {};   // abonnements push du chat : { idChat: [abonnements] }
if (!Array.isArray(registre.appareils)) registre.appareils = [];   // téléphones mémorisés : plus besoin de retaper le mot de passe
if (!Array.isArray(registre.codes)) registre.codes = [];           // codes à usage unique, pour mémoriser un nouvel appareil sans donner le vrai mot de passe
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
  try { memoriserContact(s, m); } catch (e) { /* ne doit jamais gêner la réception des messages */ }
  notifierAdminsNouveauMessage(s, m);
  if (s.messages.length > MSG_MAX) {
    for (const vieux of s.messages.splice(0, s.messages.length - MSG_MAX)) {   // le média du message effacé l'est aussi
      if (vieux.media && vieux.media.f && /^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(vieux.media.f)) fs.rm(path.join(DOSSIER, s.numero, 'medias', vieux.media.f), { force: true }, () => {});
    }
  }
}

// 👥 CONTACTS : numéros des personnes avec qui les bots discutent (visibles dans le panneau admin).
// Gardés en mémoire et dans sessions/contacts.json ; une personne = une fiche, tous bots confondus.
const FICHIER_CONTACTS = path.join(DOSSIER, 'contacts.json');
const CONTACTS_MAX = 5000;
const contacts = new Map();            // numéro (chiffres) -> fiche
const contactsMasques = new Set();     // « bot|libellé » : WhatsApp cache le vrai numéro (identifiant LID), impossible à capturer
let contactsASauver = false;
try { for (const c of JSON.parse(fs.readFileSync(FICHIER_CONTACTS, 'utf8'))) if (c && /^\d{5,16}$/.test(c.numero)) contacts.set(c.numero, c); } catch (e) {}
setInterval(() => {
  if (!contactsASauver) return;
  contactsASauver = false;
  try { fs.mkdirSync(DOSSIER, { recursive: true }); fs.writeFileSync(FICHIER_CONTACTS, JSON.stringify([...contacts.values()])); } catch (e) {}
}, 15000);

// « 👤 Ami Paul (~Paulo) · +2250700000000 » -> « Ami Paul (~Paulo) » ; « 👤 +225… » -> « »
function nomDepuisLibelle(txt) {
  let t = String(txt || '').replace(/^[\u{1F464}\u{1F916}\u{1F465}\s]+/u, '').trim();
  const i = t.lastIndexOf(' · ');
  if (i > 0) t = t.slice(0, i);
  else if (/^(\+|ID )\d/.test(t)) return '';
  return t.slice(0, 80);
}
function memoriserContact(s, m) {
  let numero = null, libelle = '';
  if (m.sens === 'recu') {
    libelle = m.de;
    numero = m.numero;
    if (!numero && !m.groupe) { contactsMasques.add(`${s.numero}|${m.de}`); if (contactsMasques.size > 2000) contactsMasques.delete(contactsMasques.values().next().value); return; }
  } else if (m.sens === 'envoye' && !m.groupe) {
    libelle = m.conv;
    numero = m.numero;
  }
  numero = String(numero || '').replace(/\D/g, '');
  if (!/^\d{5,16}$/.test(numero) || sessions.has(numero) || parkes.has(numero)) return;   // pas le numéro d'un de nos bots
  const maintenant = m.t || Date.now();
  let c = contacts.get(numero);
  if (!c) {
    c = { numero, nom: '', premier: maintenant, dernier: maintenant, recus: 0, envoyes: 0, prive: false, groupe: false, bots: {} };
    contacts.set(numero, c);
    if (contacts.size > CONTACTS_MAX) {   // trop de fiches : on retire la moins récente
      let vieux = null;
      for (const x of contacts.values()) if (!vieux || x.dernier < vieux.dernier) vieux = x;
      if (vieux) contacts.delete(vieux.numero);
    }
  }
  const nom = nomDepuisLibelle(libelle);
  if (nom) c.nom = nom;
  c.dernier = Math.max(c.dernier, maintenant);
  c.premier = Math.min(c.premier, maintenant);
  if (m.sens === 'recu') c.recus++; else c.envoyes++;
  if (m.groupe) c.groupe = true; else c.prive = true;
  c.bots[s.numero] = (c.bots[s.numero] || 0) + 1;
  contactsASauver = true;
}

const RE_MEDIA = /^[A-Za-z0-9_-]{1,80}\.(jpg|png|webp|ogg|mp3|m4a|mp4|webm|3gp)$/;
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
// Envoi d'une notification à une liste d'abonnements ; renvoie le nombre d'envois réussis et les abonnements expirés
async function pousser(abonnements, payload) {
  const corps = JSON.stringify(payload), expires = new Set();
  let envoyes = 0;
  await Promise.all(abonnements.map(async sub => {
    try { await webpush.sendNotification(sub, corps, { TTL: 60 * 60, urgency: 'high' }); envoyes++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) expires.add(sub.endpoint);
      else console.error('[PUSH] Chat :', e.statusCode || '', e.body || e.message || e);
    }
  }));
  return { envoyes, expires };
}
// Limiteur simple : true si la clé a déjà fait « max » appels pendant la fenêtre
const limitesChat = new Map();
function limiteChat(cle, max, fenetreMs) {
  const t = Date.now(), l = (limitesChat.get(cle) || []).filter(x => t - x < fenetreMs);
  if (l.length >= max) { limitesChat.set(cle, l); return true; }
  l.push(t); limitesChat.set(cle, l);
  if (limitesChat.size > 5000) limitesChat.delete(limitesChat.keys().next().value);
  return false;
}
const idChatValide = (v) => typeof v === 'string' && /^[^\s<>"'\\]{1,20}$/.test(v);
const abonnementValide = (sub) => sub && typeof sub.endpoint === 'string' && sub.endpoint.startsWith('https://') && sub.endpoint.length < 600
  && sub.keys && typeof sub.keys.p256dh === 'string' && typeof sub.keys.auth === 'string';

// Envoi d'une notification à tous les appareils admin abonnés (les abonnements expirés sont retirés)
async function envoyerPushAdmins({ title, body, tag, url }) {
  if (!PUSH_ACTIF || !registre.pushSubscriptions.length) return 0;
  const payload = JSON.stringify({ title, body, tag, url: url || '/admin' });
  const resultats = await Promise.allSettled(registre.pushSubscriptions.map(async subscription => {
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 * 60, urgency: 'high' });
      return { ok: true };
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) return { expired: subscription.endpoint };
      console.error('[PUSH] Envoi impossible :', e.statusCode || '', e.body || e.message || e);
      return null;
    }
  }));
  const expires = new Set(resultats.filter(r => r.status === 'fulfilled' && r.value && r.value.expired).map(r => r.value.expired));
  if (expires.size) {
    registre.pushSubscriptions = registre.pushSubscriptions.filter(x => !expires.has(x.endpoint));
    sauver();
  }
  return resultats.filter(r => r.status === 'fulfilled' && r.value && r.value.ok).length;
}
async function notifierAdminsNouvelleConnexion(s) {
  return envoyerPushAdmins({
    title: 'Nouvelle connexion LEYBOTDY',
    body: `Le bot du numéro +${s.numero} vient de se connecter.`,
    tag: `leybotdy-connexion-${s.numero}`
  });
}
// 💬 Nouveau message reçu par un bot (une alerte par discussion au maximum toutes les 15 s)
const dernierPushMsg = new Map();
function notifierAdminsNouveauMessage(s, m) {
  if (!PUSH_ACTIF || !registre.pushSubscriptions.length) return;
  if (m.sens !== 'recu' || (m.t && Date.now() - m.t > 90 * 1000)) return;   // pas les messages envoyés, ni l'historique ancien
  const cle = `${s.numero}|${m.conv || m.de || ''}`;
  if (Date.now() - (dernierPushMsg.get(cle) || 0) < 15000) return;
  dernierPushMsg.set(cle, Date.now());
  if (dernierPushMsg.size > 500) dernierPushMsg.delete(dernierPushMsg.keys().next().value);
  const apercu = String(m.texte || '').replace(/\s+/g, ' ').trim().slice(0, 90) || (m.media ? '📎 Média reçu' : `[${m.type || 'message'}]`);
  envoyerPushAdmins({
    title: `💬 ${m.groupe ? 'Groupe' : 'Discussion'} · bot …${s.numero.slice(-4)}`,
    body: apercu,
    tag: `leybotdy-msg-${cle}`
  }).catch(e => console.error('[PUSH] Erreur :', e.message || e));
}

function analyser(s, ligne) {
  const m = ligne.match(/CODE DE JUMELAGE : ([A-Z0-9-]+)/i);
  if (m) { s.statut = 'code'; s.codeJumelage = m[1]; return; }
  if (ligne.includes('BOT PRÊT ET CONNECTÉ')) {
    const premiereConnexion = s.statut === 'demarrage' || s.statut === 'code';   // une nouvelle connexion passe par « code »
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
  try {   // PSS : les pages partagées (Node, bibliothèques) sont réparties entre les processus au lieu d'être comptées plusieurs fois
    const p = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)\s*kB/m);
    if (p) return parseInt(p[1], 10) * 1024;
  } catch (e) {}
  try {
    const r = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)\s*kB/);
    return r ? parseInt(r[1], 10) * 1024 : null;
  } catch (e) { return null; }
}
// Mémoire du conteneur vue par Linux (cgroup), sans le cache de fichiers récupérable : c'est ce qui compte pour la limite de Render
function lireConteneur() {
  const essais = [['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat', 'inactive_file'],
                  ['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file']];
  for (const [u, st, cle] of essais) {
    try {
      const usage = parseInt(fs.readFileSync(u, 'utf8'), 10);
      if (!isFinite(usage)) continue;
      let inactif = 0;
      try { const x = fs.readFileSync(st, 'utf8').match(new RegExp('^' + cle + '\\s+(\\d+)', 'm')); if (x) inactif = parseInt(x[1], 10); } catch (e) {}
      return Math.max(0, usage - inactif);
    } catch (e) {}
  }
  return null;
}
function mesurerMemoire() {
  const gestionnaire = lireRSS(process.pid) || process.memoryUsage().rss;
  const bots = [...sessions.values()].map(s => ({ numero: s.numero, statut: s.statut, rss: s.proc && s.proc.pid ? lireRSS(s.proc.pid) : null }));
  const total = gestionnaire + bots.reduce((a, b) => a + (b.rss || 0), 0);
  if (total > memoirePic) memoirePic = total;
  const mesures = bots.filter(b => b.rss);
  const moyenneBot = mesures.length ? Math.round(mesures.reduce((a, b) => a + b.rss, 0) / mesures.length) : 0;
  return { gestionnaire, bots, total, conteneur: lireConteneur(), pic: memoirePic, limite: MEMOIRE_LIMITE, moyenneBot, max: MAX };
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
//   … ou par le jeton d'un appareil déjà mémorisé (voir plus bas), pour ne pas avoir à retaper le mot de passe à chaque fois.
const ADMIN_MDP = (process.env.ADMIN_MOT_DE_PASSE || '').trim();
const empreinte = (x) => crypto.createHash('sha256').update(String(x)).digest();
const hacher = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const ALPHABET_CODE = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';   // sans 0/O/1/I, pour éviter les confusions en recopiant
function genererCode(longueur) {
  const octets = crypto.randomBytes(longueur);
  let c = '';
  for (let i = 0; i < longueur; i++) c += ALPHABET_CODE[octets[i] % ALPHABET_CODE.length];
  return c;
}
// 🔒 Blocage de connexion admin (par IP) : 8 mots de passe faux -> blocage de 10 minutes à heure FIXE.
//  - un appareil mémorisé (jeton valide) passe toujours, même si l'IP est bloquée ;
//  - une demande SANS mot de passe (ex. la page qui charge une image sans être connectée) n'est pas un essai : elle ne compte pas ;
//  - pendant le blocage, les demandes ne le prolongent pas ; à la fin, le compteur repart à zéro.
const echecsAdmin = new Map();   // ip -> { n: [dates des échecs], jusqua: fin du blocage }
const BLOCAGE_ADMIN_MS = 10 * 60 * 1000, ECHECS_ADMIN_MAX = 8;
function admin(req, res, next) {
  if (!ADMIN_MDP) return res.status(503).json({ erreur: 'ADMIN_MOT_DE_PASSE n’est pas défini sur Render.' });
  const jetonAppareil = req.headers['x-device-token'];
  if (jetonAppareil && typeof jetonAppareil === 'string') {
    const h = hacher(jetonAppareil);
    const appareil = registre.appareils.find(a => a.hash === h);
    if (appareil) { appareil.derniereUtilisation = Date.now(); req.appareilId = appareil.id; return next(); }
  }
  const t = Date.now();
  const e = echecsAdmin.get(req.ip) || { n: [], jusqua: 0 };
  if (e.jusqua > t) {
    const reste = Math.ceil((e.jusqua - t) / 1000);
    res.set('Retry-After', String(reste));
    return res.status(429).json({ erreur: `Trop d’essais. Réessaie dans ${Math.ceil(reste / 60)} minute(s).`, reste });
  }
  if (e.jusqua) { e.jusqua = 0; e.n = []; }   // blocage terminé : on repart de zéro
  const saisie = req.headers['x-admin-key'];
  if (!saisie || typeof saisie !== 'string') return res.status(401).json({ erreur: 'Connexion requise.' });   // pas un essai de mot de passe
  const ok = crypto.timingSafeEqual(empreinte(saisie), empreinte(ADMIN_MDP));
  if (!ok) {
    e.n = e.n.filter(x => t - x < BLOCAGE_ADMIN_MS); e.n.push(t);
    if (e.n.length >= ECHECS_ADMIN_MAX) e.jusqua = t + BLOCAGE_ADMIN_MS;
    echecsAdmin.set(req.ip, e);
    return res.status(401).json({ erreur: 'Mot de passe incorrect.' });
  }
  if (e.n.length) { e.n = []; echecsAdmin.set(req.ip, e); }   // bon mot de passe : compteur remis à zéro
  next();
}
// 📱 APPAREILS MÉMORISÉS : une fois connecté, ce téléphone n'a plus besoin de retaper le mot de passe.
app.post('/api/admin/appareils/liste', admin, (req, res) => {
  registre.codes = registre.codes.filter(c => !c.utiliseLe && c.expireLe > Date.now());
  res.json({
    appareils: registre.appareils.map(a => ({ id: a.id, nom: a.nom, creeLe: a.creeLe, derniereUtilisation: a.derniereUtilisation, cetAppareil: a.id === req.appareilId })),
    codes: registre.codes.map(c => ({ id: c.id, nom: c.nom, creeLe: c.creeLe, expireLe: c.expireLe }))
  });
});
// Mémorise CET appareil (celui qui vient de taper le vrai mot de passe) : renvoie un jeton propre à lui, jamais le mot de passe lui-même.
app.post('/api/admin/appareils/memoriser', admin, (req, res) => {
  const t = Date.now(), jeton = crypto.randomBytes(32).toString('hex'), id = crypto.randomBytes(8).toString('hex');
  registre.appareils.push({ id, hash: hacher(jeton), nom: String((req.body && req.body.nom) || '').slice(0, 40) || 'Cet appareil', creeLe: t, derniereUtilisation: t });
  if (registre.appareils.length > 50) registre.appareils.shift();   // sécurité : pas de croissance infinie
  sauver();
  res.json({ ok: true, jeton });
});
app.post('/api/admin/appareils/revoquer', admin, (req, res) => {
  const avant = registre.appareils.length;
  registre.appareils = registre.appareils.filter(a => a.id !== (req.body && req.body.id));
  if (registre.appareils.length === avant) return res.status(404).json({ erreur: 'Appareil introuvable.' });
  sauver();
  res.json({ ok: true });
});
// Code à usage unique : un admin déjà connecté en crée un et le transmet (vocalement, par un autre message…) à la personne
// qui veut se connecter sans qu'on lui donne le vrai mot de passe. Valable 30 min, et redevient inutilisable dès qu'il a servi.
app.post('/api/admin/appareils/generer-code', admin, (req, res) => {
  registre.codes = registre.codes.filter(c => !c.utiliseLe && c.expireLe > Date.now());
  if (registre.codes.length >= 20) return res.status(429).json({ erreur: 'Trop de codes en attente : annule-en un avant d’en créer un nouveau.' });
  const code = genererCode(8), id = crypto.randomBytes(8).toString('hex'), t = Date.now();
  registre.codes.push({ id, hash: hacher(code), nom: String((req.body && req.body.nom) || '').slice(0, 40), creeLe: t, expireLe: t + 30 * 60 * 1000, utiliseLe: null });
  sauver();
  res.json({ ok: true, code, expireLe: t + 30 * 60 * 1000 });
});
app.post('/api/admin/appareils/revoquer-code', admin, (req, res) => {
  const avant = registre.codes.length;
  registre.codes = registre.codes.filter(c => c.id !== (req.body && req.body.id));
  if (registre.codes.length === avant) return res.status(404).json({ erreur: 'Code introuvable.' });
  sauver();
  res.json({ ok: true });
});
// Échange d'un code à usage unique contre un jeton d'appareil. Pas besoin du vrai mot de passe ici : c'est tout l'intérêt.
const echecsCode = new Map();
app.post('/api/admin/appareils/echanger-code', (req, res) => {
  const t = Date.now(), l = (echecsCode.get(req.ip) || []).filter(x => t - x < 600000);
  if (l.length >= 10) { const reste = Math.max(1, Math.ceil((l[0] + 600000 - t) / 1000)); res.set('Retry-After', String(reste)); return res.status(429).json({ erreur: `Trop d’essais, réessaie dans ${Math.ceil(reste / 60)} minute(s).`, reste }); }
  const saisi = String((req.body && req.body.code) || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const h = hacher(saisi);
  const entree = registre.codes.find(c => c.hash === h);
  if (!entree || entree.utiliseLe || entree.expireLe < t) { l.push(t); echecsCode.set(req.ip, l); return res.status(401).json({ erreur: 'Code invalide, déjà utilisé ou expiré.' }); }
  entree.utiliseLe = t;
  const jeton = crypto.randomBytes(32).toString('hex'), id = crypto.randomBytes(8).toString('hex');
  registre.appareils.push({ id, hash: hacher(jeton), nom: entree.nom || String((req.body && req.body.nom) || '').slice(0, 40) || 'Nouvel appareil', creeLe: t, derniereUtilisation: t });
  if (registre.appareils.length > 50) registre.appareils.shift();
  sauver();
  res.json({ ok: true, jeton });
});

app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// 🔔 NOTIFICATIONS DU CHAT : un message privé reçu arrive en notification, même appli fermée.
app.get('/api/chat/push/key', (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Les notifications ne sont pas encore configurées sur le serveur.' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});
app.post('/api/chat/push/subscribe', (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Les notifications ne sont pas encore configurées sur le serveur.' });
  if (limiteChat('sub|' + req.ip, 30, 10 * 60 * 1000)) return res.status(429).json({ erreur: 'Trop de demandes, réessaie plus tard.' });
  const { id, subscription: sub } = req.body || {};
  if (!idChatValide(id) || !abonnementValide(sub)) return res.status(400).json({ erreur: 'Abonnement invalide.' });
  for (const k of Object.keys(registre.chatPush)) {   // un appareil n'appartient qu'à un seul ID
    const reste = registre.chatPush[k].filter(x => x.endpoint !== sub.endpoint);
    if (reste.length) registre.chatPush[k] = reste; else delete registre.chatPush[k];
  }
  if (!registre.chatPush[id] && Object.keys(registre.chatPush).length >= 2000) return res.status(503).json({ erreur: 'Trop d’abonnés pour le moment.' });
  registre.chatPush[id] = [...(registre.chatPush[id] || []), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }].slice(-5);
  sauver();
  res.json({ ok: true });
});
// Test : envoie une notification aux appareils enregistrés sous cet ID et dit combien il y en a
app.post('/api/chat/push/test', async (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Les notifications ne sont pas encore configurées sur le serveur.' });
  if (limiteChat('t|' + req.ip, 5, 60 * 1000)) return res.status(429).json({ erreur: 'Trop de tests, réessaie dans une minute.' });
  const { id } = req.body || {};
  if (!idChatValide(id)) return res.status(400).json({ erreur: 'ID invalide.' });
  const abonnements = registre.chatPush[id] || [];
  if (!abonnements.length) return res.json({ ok: true, appareils: 0, envoyes: 0 });
  const { envoyes, expires } = await pousser(abonnements, { kind: 'test', title: '💬 Test LEYBOTDY', body: 'Les notifications du chat fonctionnent ✅', tag: 'leybotdy-chat-test', url: '/chat' });
  if (expires.size) {
    const reste = abonnements.filter(x => !expires.has(x.endpoint));
    if (reste.length) registre.chatPush[id] = reste; else delete registre.chatPush[id];
    sauver();
  }
  res.json({ ok: true, appareils: abonnements.length, envoyes });
});
app.post('/api/chat/push/notifier', async (req, res) => {
  if (!PUSH_ACTIF) return res.json({ ok: true, envoyes: 0 });
  const { de, pour, texte } = req.body || {};
  if (!idChatValide(de) || !idChatValide(pour) || de === pour) return res.status(400).json({ erreur: 'Requête invalide.' });
  if (limiteChat('n|' + req.ip, 60, 60 * 1000)) return res.status(429).json({ erreur: 'Trop de demandes.' });
  const abonnements = registre.chatPush[pour];
  if (!abonnements || !abonnements.length) return res.json({ ok: true, envoyes: 0 });
  if (limiteChat(`p|${de}|${pour}`, 1, 8000)) return res.json({ ok: true, envoyes: 0 });   // rafale de messages : une seule alerte
  const apercu = String(texte || '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Nouveau message';
  const { envoyes, expires } = await pousser(abonnements, { kind: 'chat', title: `💬 ${de}`, body: apercu, tag: `leybotdy-chat-${de}`, url: '/chat' });
  if (expires.size) {
    const reste = abonnements.filter(x => !expires.has(x.endpoint));
    if (reste.length) registre.chatPush[pour] = reste; else delete registre.chatPush[pour];
    sauver();
  }
  res.json({ ok: true, envoyes });
});

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
app.post('/api/admin/push/test', admin, async (req, res) => {
  if (!PUSH_ACTIF) return res.status(503).json({ erreur: 'Notifications non configurées : ajoute VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY sur Render.' });
  if (!registre.pushSubscriptions.length) return res.status(409).json({ erreur: 'Aucun appareil abonné : active d’abord les notifications.' });
  const envoyes = await envoyerPushAdmins({ title: 'LEYBOTDY · test', body: 'Les notifications fonctionnent ✅', tag: 'leybotdy-test' });
  res.json({ ok: true, envoyes, abonnes: registre.pushSubscriptions.length });
});
// Génère une paire de clés VAPID à copier dans les variables d'environnement de Render (rien n'est enregistré ici)
app.post('/api/admin/push/generer', admin, (req, res) => {
  const k = webpush.generateVAPIDKeys();
  res.json({ publicKey: k.publicKey, privateKey: k.privateKey });
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
const TYPES_MEDIA = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', '3gp': 'video/3gpp' };
app.get('/api/admin/media/:bot/:f', admin, (req, res) => {
  const { bot, f } = req.params;
  if (!/^\d{5,16}$/.test(bot) || !RE_MEDIA.test(f)) return res.status(400).json({ erreur: 'Fichier invalide.' });
  const chemin = path.join(DOSSIER, bot, 'medias', f);
  if (!fs.existsSync(chemin)) return res.status(404).json({ erreur: 'Média expiré.' });
  res.set('Content-Type', TYPES_MEDIA[f.split('.').pop()]);
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(chemin);
});

// 👥 Liste des numéros capturés (recherche et filtre par bot possibles)
app.post('/api/admin/contacts', admin, (req, res) => {
  const b = req.body || {};
  const q = String(b.q || '').trim().toLowerCase(), bot = String(b.bot || '').replace(/\D/g, '');
  let liste = [...contacts.values()];
  if (bot) liste = liste.filter(c => c.bots && c.bots[bot]);
  if (q) liste = liste.filter(c => `${c.numero} ${c.nom || ''}`.toLowerCase().includes(q.replace(/^\+/, '')));
  liste.sort((a, c) => c.dernier - a.dernier);
  res.json({ total: contacts.size, correspondants: liste.length, masques: contactsMasques.size, contacts: liste.slice(0, 500), bots: [...sessions.keys(), ...parkes.keys()] });
});
app.post('/api/admin/contacts/supprimer', admin, (req, res) => {
  const numero = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  if (!contacts.delete(numero)) return res.status(404).json({ erreur: 'Contact introuvable.' });
  contactsASauver = true;
  res.json({ ok: true });
});
// 🗑 Supprime d'un coup tous les messages gardés par tous les bots (+ leurs médias sur le disque), et les numéros si demandé
app.post('/api/admin/messages/tout-supprimer', admin, (req, res) => {
  const avecContacts = !(req.body && req.body.contacts === false);
  let messages = 0, medias = 0;
  for (const s of [...sessions.values(), ...parkes.values()]) {
    if (!Array.isArray(s.messages)) continue;
    messages += s.messages.length;
    for (const m of s.messages) if (m && m.media) medias++;
    s.messages.splice(0, s.messages.length);   // même tableau, pour que stocker() continue de fonctionner
    try { fs.rmSync(path.join(DOSSIER, s.numero, 'medias'), { recursive: true, force: true }); } catch (e) {}
  }
  let numeros = 0;
  if (avecContacts) { numeros = contacts.size; contacts.clear(); contactsMasques.clear(); contactsASauver = true; }
  console.log(`[ADMIN] 🗑 Tout supprimé : ${messages} message(s), ${medias} média(s), ${numeros} numéro(s)`);
  res.json({ ok: true, messages, medias, numeros });
});
app.post('/api/admin/contacts/vider', admin, (req, res) => {
  const n = contacts.size;
  contacts.clear(); contactsMasques.clear();
  contactsASauver = true;
  res.json({ ok: true, supprimes: n });
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

// 🧹 Libération mémoire d'un bot précis ou de tous les bots.
// Chaque worker envoie lui-même un avertissement à son propre compte WhatsApp.
app.post('/api/admin/memoire/liberer', admin, async (req, res) => {
  const numeroDemande = String((req.body && req.body.numero) || '').replace(/\D/g, '');
  let actifs = [...sessions.values()].filter(s => s.proc && s.proc.connected);

  if (numeroDemande) {
    const cible = sessions.get(numeroDemande);
    if (!cible) return res.status(404).json({ erreur: 'Bot introuvable ou en attente. Il doit être actif pour recevoir la commande.' });
    if (!cible.proc || !cible.proc.connected) return res.status(409).json({ erreur: 'Ce bot ne possède pas de processus actif. Reprends-le avant de vider sa mémoire.' });
    actifs = [cible];
  }

  if (!actifs.length) {
    if (typeof global.gc === 'function') global.gc();
    return res.json({ ok: true, bots: 0, nettoyes: 0, avertissementsEnvoyes: 0, message: 'Aucun bot actif à nettoyer.' });
  }

  const resultats = await Promise.all(actifs.map(s => new Promise(resolve => {
    const requestId = crypto.randomBytes(10).toString('hex');
    const proc = s.proc;
    const timer = setTimeout(() => {
      proc.off('message', listener);
      resolve({ numero: s.numero, ok: false, notificationEnvoyee: false, erreur: 'Délai dépassé' });
    }, 15000);
    const listener = message => {
      if (!message || message.type !== 'ADMIN_CLEAR_MEMORY_RESULT' || message.requestId !== requestId) return;
      clearTimeout(timer);
      proc.off('message', listener);
      resolve({ numero: s.numero, ok: !!message.ok, notificationEnvoyee: !!message.notificationEnvoyee, erreur: message.erreur || message.erreurNotification || null });
    };
    proc.on('message', listener);
    try {
      proc.send({ type: 'ADMIN_CLEAR_MEMORY', requestId }, err => {
        if (err) {
          clearTimeout(timer); proc.off('message', listener);
          resolve({ numero: s.numero, ok: false, notificationEnvoyee: false, erreur: err.message });
        }
      });
    } catch (e) {
      clearTimeout(timer); proc.off('message', listener);
      resolve({ numero: s.numero, ok: false, notificationEnvoyee: false, erreur: e.message });
    }
  })));

  if (typeof global.gc === 'function') global.gc();
  const nettoyes = resultats.filter(x => x.ok).length;
  const avertissementsEnvoyes = resultats.filter(x => x.notificationEnvoyee).length;
  console.log(`[ADMIN] 🧹 Purge mémoire : ${nettoyes}/${actifs.length} bots · avertissements ${avertissementsEnvoyes}/${actifs.length}`);
  res.json({ ok: true, bot: numeroDemande || null, bots: actifs.length, nettoyes, avertissementsEnvoyes, resultats });
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
// 🔄 Redémarre le bot d'UN compte précis. Sa session WhatsApp (sessions/<numero>) est conservée ;
// seul le processus du bot est arrêté puis relancé (un compte en pause reste en pause).
app.post('/api/admin/redemarrer', admin, (req, res) => {
  const numero = String((req.body && req.body.numero) || '');
  const s = sessions.get(numero);
  if (!s) return res.status(404).json({ erreur: 'Session active introuvable.' });
  if (s.statut === 'demarrage') return res.status(409).json({ erreur: 'Ce compte est en cours de jumelage : attends qu’il soit connecté.' });
  if (s.redemarrageEnCours) return res.status(409).json({ erreur: 'Un redémarrage est déjà en cours pour ce compte.' });
  s.redemarrageEnCours = true;
  const ancien = s.proc;
  s.proc = null;   // arrêt voulu : le gestionnaire ne le prend pas pour un plantage
  if (ancien) { try { ancien.kill('SIGTERM'); } catch (e) {} }
  s.essais = 0;
  if (s.statut !== 'pause') s.statut = 'reconnexion';
  setTimeout(() => { s.redemarrageEnCours = false; if (sessions.get(numero) === s && !s.proc) lancer(s); }, 2500);
  console.log(`[ADMIN] 🔄 Redémarrage du bot …${numero.slice(-4)}`);
  res.json({ ok: true });
});

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
