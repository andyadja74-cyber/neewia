const crypto = require('crypto');
if (!globalThis.crypto) globalThis.crypto = crypto;

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

// ───────────── Configuration ─────────────
const PORT = process.env.PORT || 3000;
const AUTH_DIR = process.env.AUTH_DIR || './auth_info'; // sur Render : chemin d'un Persistent Disk
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;            // OBLIGATOIRE : protège /start et /status
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const CODE_INTERVAL_MS = (Number(process.env.CODE_INTERVAL_MIN) || 2) * 1000; // 1 nouveau code toutes les 15 min
const CODE_VALID_MS = 2000;         // durée de validité approximative d'un code
const ERROR_COOLDOWN_MS = 5 * 1000; // pause après une erreur
const MAX_CODES = Number(process.env.MAX_CODES) || 0; // 0 = illimité (tant que non apparié)
const START_COOLDOWN_MS = 1000;     // délai minimum entre deux /start

if (!ADMIN_TOKEN) {
  console.error('❌ Variable ADMIN_TOKEN manquante (définis-la dans Render > Environment).');
  process.exit(1);
}

process.on('uncaughtException', (err) => {
  console.error('💥 uncaughtException :', err);
  process.exit(1); // Render relance le service proprement
});
process.on('unhandledRejection', (reason) => console.error('⚠️ Promesse rejetée :', reason));

// ───────────── État ─────────────
// state : idle | connecting | pairing | connected | banned | error
const bot = { state: 'idle', message: 'En attente du numéro...', code: null, codeAt: null, nextAt: null };
const setState = (state, message, code = null) => {
  bot.state = state;
  bot.message = message;
  bot.code = code;
  if (state !== 'pairing') { bot.codeAt = null; bot.nextAt = null; }
  console.log(`[${state}] ${message}${code ? ' ' + code : ''}`);
};

let sock = null;
let socketId = 0;
let phone = null;
let lastCodeAt = 0;
let codesIssued = 0;
let requesting = false;
let pairTimer = null;
let reconnectTimer = null;
let reconnectDelay = 2_000;

// ───────────── Détection de bannissement ─────────────
const BAN_WEBHOOK_URL = process.env.BAN_WEBHOOK_URL || null; // optionnel : URL (Discord/Slack/autre) notifiée en cas de ban
const BAN_STATUS_CODES = new Set([403]); // codes HTTP renvoyés par WhatsApp quand le numéro/l'appareil est bloqué
const BAN_KEYWORDS = /banned|blocked|restricted|forbidden/i; // filet de sécurité si le code HTTP n'est pas exposé

function looksLikeBan(err) {
  const status = err?.output?.statusCode || err?.status || err?.data?.statusCode;
  if (status && BAN_STATUS_CODES.has(Number(status))) return true;
  const msg = String(err?.message || err?.output?.payload?.message || '');
  return BAN_KEYWORDS.test(msg);
}

async function notifyBan(reason) {
  console.error(`🚨 BAN DÉTECTÉ : ${reason}`);
  if (!BAN_WEBHOOK_URL) return;
  try {
    await fetch(BAN_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `🚨 Titan Bot : numéro ${phone || '?'} probablement banni — ${reason}` })
    });
  } catch (e) {
    console.error('⚠️ Échec de la notification de ban :', e?.message || e);
  }
}

function handleBan(reason) {
  setState('banned', `🚨 Accès refusé : numéro probablement banni ou restreint (${reason}).`);
  notifyBan(reason);
  closeSocket();
}

function closeSocket() {
  clearTimeout(pairTimer);
  clearTimeout(reconnectTimer);
  pairTimer = null;
  reconnectTimer = null;
  requesting = false;
  if (sock) {
    try { sock.ev.removeAllListeners(); } catch (_) {}
    try { sock.ws.close(); } catch (_) {}
    sock = null;
  }
}

function schedulePairing(delay, id) {
  clearTimeout(pairTimer);
  pairTimer = setTimeout(() => requestCode(id), Math.max(0, delay));
}

// ───────────── Demande de code (max 1/minute) ─────────────
async function requestCode(id) {
  pairTimer = null;
  if (id !== socketId || !sock || requesting) return;
  if (sock.authState.creds.registered) return;

  if (!phone) {
    setState('idle', 'En attente du numéro...');
    closeSocket();
    return;
  }
  if (MAX_CODES > 0 && codesIssued >= MAX_CODES) {
    setState('idle', `Aucun appariement après ${MAX_CODES} codes. Relance plus tard.`);
    closeSocket();
    return;
  }

  const wait = lastCodeAt + CODE_INTERVAL_MS - Date.now();
  if (wait > 0) return schedulePairing(wait, id);

  requesting = true;
  lastCodeAt = Date.now();
  codesIssued++;
  try {
    let code = await sock.requestPairingCode(phone);
    if (id !== socketId) return;
    code = code?.match(/.{1,4}/g)?.join('-') || code;
    setState('pairing', `Entre ce code dans WhatsApp maintenant (valable ~1 min). Code n°${codesIssued}`, code);
    bot.codeAt = Date.now();
    bot.nextAt = Date.now() + CODE_INTERVAL_MS;
    schedulePairing(CODE_INTERVAL_MS, id);
  } catch (err) {
    if (id !== socketId) return;
    console.error('❌ Erreur demande de code :', err?.message || err);
    if (looksLikeBan(err)) {
      handleBan('erreur lors de la demande de code');
    } else {
      setState('error', 'Erreur de génération. Nouvel essai dans 5 min (voir les logs).');
      schedulePairing(ERROR_COOLDOWN_MS, id);
    }
  } finally {
    requesting = false;
  }
}

// ───────────── Connexion ─────────────
async function connect() {
  closeSocket();
  const id = ++socketId;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  if (id !== socketId) return;

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: LOG_LEVEL }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false
  });
  sock.ev.on('creds.update', saveCreds);

  // Filet de sécurité : si un bannissement arrive pendant l'exécution (ex: en envoyant un
  // message via sock.sendMessage(...) ailleurs dans le code), passe l'erreur par ici :
  //   try { await sock.sendMessage(jid, { text }); }
  //   catch (err) { if (looksLikeBan(err)) handleBan('échec d'envoi de message'); else throw err; }
  sock.ev.on('connection.update', (update) => {
    if (id !== socketId) return;
    const { connection, lastDisconnect, qr } = update;

    // Le socket est prêt à être apparié (l'évènement "qr" sert de signal)
    if (qr && !sock.authState.creds.registered && !pairTimer && !requesting) {
      schedulePairing(1_000, id);
    }

    if (connection === 'open') {
      clearTimeout(pairTimer);
      pairTimer = null;
      codesIssued = 0;
      reconnectDelay = 2_000;
      setState('connected', '⚡ TITAN BOT CONNECTÉ AVEC SUCCÈS !');
      return;
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (status === DisconnectReason.forbidden || looksLikeBan(lastDisconnect?.error)) { // 403
        handleBan('connexion fermée avec un statut de bannissement');
        return;
      }
      if (status === DisconnectReason.loggedOut) { // 401 : déconnecté depuis le téléphone
        fs.rmSync(path.resolve(AUTH_DIR), { recursive: true, force: true });
        setState('idle', 'Session déconnectée depuis le téléphone. Refais un appariement.');
        closeSocket();
        return;
      }

      // 515 (restartRequired après pairing), coupure réseau, etc. → on reconnecte
      if (bot.state === 'connected') setState('connecting', 'Reconnexion...');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => connect().catch(console.error), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 1000);
    }
  });
}

// ───────────── Serveur web ─────────────
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));

function authorized(req) {
  const given = Buffer.from(String(req.get('x-admin-token') || ''));
  const expected = Buffer.from(ADMIN_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const hits = new Map();
function rateLimited(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}

let lastStartAt = 0;

app.get('/ping', (_req, res) => res.status(200).send('OK - Bot actif'));

app.get('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Token invalide' });
  const now = Date.now();
  res.json({
    state: bot.state,
    message: bot.message,
    code: bot.code,
    expiresInMs: bot.codeAt ? Math.max(0, bot.codeAt + CODE_VALID_MS - now) : null,
    nextInMs: bot.nextAt ? Math.max(0, bot.nextAt - now) : null
  });
});

app.post('/start', async (req, res) => {
  if (rateLimited(req.ip, 10 * 1000)) {
    return res.status(429).json({ error: 'Trop de tentatives, réessaie plus tard.' });
  }
  if (!authorized(req)) return res.status(401).json({ error: 'Token invalide' });

  const cleaned = String(req.body?.phone || '').replace(/\D/g, '');
  if (cleaned.length < 10 || cleaned.length > 15) {
    return res.status(400).json({ error: 'Le numéro doit contenir 10 à 15 chiffres avec l’indicatif pays.' });
  }
  if (bot.state === 'connected') {
    return res.status(409).json({ error: 'Le bot est déjà connecté.' });
  }
  const sinceLast = Date.now() - lastStartAt;
  if (sinceLast < START_COOLDOWN_MS) {
    const secs = Math.ceil((START_COOLDOWN_MS - sinceLast) / 1000);
    return res.status(429).json({ error: `Patiente ${secs}s avant de relancer.` });
  }

  lastStartAt = Date.now();
  phone = cleaned;
  codesIssued = 0;
  setState('connecting', 'Connexion à WhatsApp...');
  connect().catch((err) => {
    console.error(err);
    setState('error', 'Impossible de démarrer la connexion (voir les logs).');
  });
  res.json({ ok: true });
});

app.get('/', (_req, res) => {
  res.type('html').send(PAGE);
});

const PAGE = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Titan Bot - Connexion WhatsApp</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
  body { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #311042 100%); background-attachment: fixed;
    display: flex; justify-content: center; align-items: center; min-height: 100vh; color: #f8fafc; padding: 16px; }
  .card { background: rgba(255,255,255,.05); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,.15);
    padding: 40px 30px; border-radius: 24px; box-shadow: 0 25px 50px rgba(0,0,0,.4); width: 100%; max-width: 420px; text-align: center; }
  .logo { font-size: 36px; margin-bottom: 12px; }
  h2 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  p { color: #cbd5e1; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
  .input-group { margin-bottom: 16px; text-align: left; }
  label { display: block; font-size: 13px; font-weight: 600; color: #e2e8f0; margin-bottom: 6px; }
  input { width: 100%; padding: 14px 16px; background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.2);
    border-radius: 12px; font-size: 16px; color: #fff; outline: none; }
  input:focus { border-color: #60a5fa; box-shadow: 0 0 0 4px rgba(96,165,250,.2); }
  button { background: linear-gradient(135deg, #3b82f6, #6366f1); color: #fff; border: none; padding: 14px; width: 100%;
    border-radius: 12px; font-size: 16px; cursor: pointer; font-weight: 600; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .code-container { margin-top: 25px; background: rgba(255,255,255,.03); padding: 20px; border-radius: 16px; border: 1px solid rgba(255,255,255,.1); }
  .code-label { font-size: 12px; text-transform: uppercase; font-weight: 700; color: #94a3b8; margin-bottom: 8px; letter-spacing: 1px; }
  #code { font-size: 26px; font-weight: 700; color: #38bdf8; letter-spacing: 2px; word-break: break-all; min-height: 34px; }
  #msg { font-size: 14px; color: #cbd5e1; margin-top: 8px; }
  .err { color: #f87171 !important; }
</style>
</head>
<body>
<div class="card">
  <div class="logo">💎</div>
  <h2>Titan Bot WhatsApp</h2>
  <p>Entre ton numéro avec l'indicatif pays (ex : 22501020304) et ton token admin.</p>
  <form id="form">
    <div class="input-group"><label for="phone">Numéro WhatsApp</label>
      <input id="phone" type="text" inputmode="numeric" placeholder="Ex: 2250150649187" required></div>
    <div class="input-group"><label for="token">Token admin</label>
      <input id="token" type="password" autocomplete="current-password" required></div>
    <button id="btn" type="submit">Générer le code</button>
  </form>
  <div class="code-container">
    <div class="code-label">Statut actuel</div>
    <div id="code"></div>
    <div id="msg">En attente...</div>
  </div>
</div>
<script>
  const $ = (id) => document.getElementById(id);
  const headers = () => ({ 'Content-Type': 'application/json', 'x-admin-token': $('token').value });

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('btn').disabled = true;
    try {
      const res = await fetch('/start', { method: 'POST', headers: headers(), body: JSON.stringify({ phone: $('phone').value }) });
      const data = await res.json();
      $('msg').className = res.ok ? '' : 'err';
      if (!res.ok) $('msg').textContent = data.error || 'Erreur';
    } catch (_) { $('msg').textContent = 'Erreur réseau'; }
    setTimeout(() => { $('btn').disabled = false; }, 5000);
  });

  let last = null, receivedAt = 0;
  const mmss = (ms) => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function render() {
    if (!last) return;
    const el = Date.now() - receivedAt;
    let text = last.message;
    let code = last.code || '';
    if (last.state === 'pairing' && last.expiresInMs !== null) {
      const left = last.expiresInMs - el;
      const next = last.nextInMs - el;
      if (left > 0) text += ' — expire dans ' + mmss(left);
      else { code = ''; text = 'Code expiré. Prochain code dans ' + mmss(Math.max(0, next)); }
    }
    $('code').textContent = code;
    $('msg').textContent = text;
    $('msg').className = (last.state === 'banned' || last.state === 'error') ? 'err' : '';
  }

  async function poll() {
    if (!$('token').value) return;
    try {
      const res = await fetch('/status', { headers: headers() });
      if (!res.ok) return;
      last = await res.json();
      receivedAt = Date.now();
      render();
    } catch (_) {}
  }
  setInterval(poll, 4000);
  setInterval(render, 1000);
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`🚀 Serveur web sur le port ${PORT}`);
  // Reprise automatique si une session déjà appariée existe (disque persistant)
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
    if (creds.registered) {
      setState('connecting', 'Reprise de la session existante...');
      connect().catch(console.error);
    }
  } catch (_) { /* pas de session : on attend /start */ }
});
