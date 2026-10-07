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
const LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

const CODE_INTERVAL_MS = (Number(process.env.CODE_INTERVAL_MIN) || 9) * 1000; // 1 nouveau code toutes les 2 min (modifiable via CODE_INTERVAL_MIN)
const CODE_VALID_MS = 9 * 1000;    // durée de validité approximative d'un code
const ERROR_COOLDOWN_MS = 5 * 1000; // pause après une erreur
const MAX_CODES = Number(process.env.MAX_CODES) || 0; // 0 = illimité (tant que non apparié)
const START_COOLDOWN_MS = 1000;     // délai minimum entre deux /start

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
  const now = Date.now();
  res.json({
    state: bot.state,
    message: bot.message,
    code: bot.code,
    expiresInMs: bot.codeAt ? Math.max(0, bot.codeAt + CODE_VALID_MS - now) : null,
    nextInMs: bot.nextAt ? Math.max(0, bot.nextAt - now) : null
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur web sur le port ${PORT}`);
  // Reprise automatique si une session déjà appariée existe (disque persistant)
  let resumed = false;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'creds.json'), 'utf8'));
    if (creds.registered) {
      resumed = true;
      setState('connecting', 'Reprise de la session existante...');
      connect().catch(console.error);
    }
  } catch (_) { /* pas de session : on attend /start */ }

  // Numéro défini dans la variable d'environnement PHONE_NUMBER : démarrage automatique de l'appariement
  const envPhone = String(process.env.PHONE_NUMBER || '').replace(/\D/g, '');
  if (!resumed && envPhone.length >= 10 && envPhone.length <= 15) {
    phone = envPhone;
    codesIssued = 0;
    setState('connecting', 'Connexion à WhatsApp...');
    connect().catch((err) => {
      console.error(err);
      setState('error', 'Impossible de démarrer la connexion (voir les logs).');
    });
  }
});
