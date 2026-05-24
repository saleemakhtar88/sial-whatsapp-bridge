const fs = require('fs');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const config = require('./config');
const logger = require('./logger');

let client = null;
let isReady = false;
let lastQr = null;
let lastQrDataUrl = null;

// --- Auto-recovery state ---
let reinitializing = false;
let initStartedAt = 0;       // when the current init() began
let stuckReinitCount = 0;    // consecutive "authenticated but never ready" reinits
let watchdog = null;

const STUCK_MS    = 90 * 1000;   // not-ready (no QR) longer than this → reinit
const WATCHDOG_MS = 60 * 1000;   // health-check interval
const MAX_STUCK_REINITS = 2;     // after this many stuck reinits, clear session → QR

function ready() {
  return isReady;
}

function getStatus() {
  return { ready: isReady, hasQr: Boolean(lastQr) };
}

async function getQrDataUrl() {
  return lastQrDataUrl;
}

function normalizeNumber(raw) {
  return String(raw).replace(/\D/g, '');
}

// Errors that mean the underlying WhatsApp Web session/browser is dead and a
// plain retry won't help — the client must be torn down + reinitialized.
function isSessionError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return m.includes('detached frame')
      || m.includes('session closed')
      || m.includes('target closed')
      || m.includes('execution context was destroyed')
      || m.includes('protocol error')
      || m.includes('page has been closed')
      || m.includes('cannot read properties of undefined');
}

async function destroyClient() {
  if (!client) return;
  const c = client;
  client = null;
  try { await c.destroy(); } catch (_) {}
}

// Tear down + re-create the client. Optionally wipe the saved session first
// (used when reconnect keeps getting stuck — forces a fresh QR).
async function reinitialize(reason, { clearSession = false } = {}) {
  if (reinitializing) return;
  reinitializing = true;
  isReady = false;
  logger.warn(`[RECOVERY] reinitializing WhatsApp client — ${reason}${clearSession ? ' (clearing session)' : ''}`);
  try {
    await destroyClient();
    if (clearSession) {
      try {
        fs.rmSync(config.sessionPath, { recursive: true, force: true });
        logger.warn('[RECOVERY] saved session cleared — a new QR will be shown.');
      } catch (e) {
        logger.error(`[RECOVERY] could not clear session: ${e.message}`);
      }
    }
  } catch (_) {}
  reinitializing = false;
  init();   // re-create + initialize (sets initStartedAt, attaches handlers)
}

// Run a send, and if it fails with a fatal session error, flag the client
// not-ready and kick off a reinit (the queue will pause until ready again).
// Non-session errors (e.g. "not registered on WhatsApp") just propagate.
async function guardedSend(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isSessionError(e)) {
      logger.error(`[RECOVERY] session error during send: ${e.message}`);
      isReady = false;
      reinitialize('send session error');
    }
    throw e;
  }
}

async function sendMessage(to, message) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }
  const number = normalizeNumber(to);
  if (!number || number.length < 8) {
    throw new Error(`Invalid phone number: "${to}"`);
  }
  return guardedSend(async () => {
    let chatId;
    if (config.verifyNumber) {
      const numberId = await client.getNumberId(number);
      if (!numberId) throw new Error(`Number ${number} is not registered on WhatsApp`);
      chatId = numberId._serialized;
    } else {
      chatId = `${number}@c.us`;
    }
    return client.sendMessage(chatId, message);
  });
}

// Check whether a number is registered on WhatsApp WITHOUT sending anything.
// Uses getNumberId (a real WhatsApp lookup that returns null if the number is
// not on WhatsApp). Guarded so a dead session triggers auto-recovery just like
// a send would. Lets the caller (SIAL) pre-verify + cache numbers so bulk sends
// never have to re-verify each one.
async function checkNumber(to) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }
  const number = normalizeNumber(to);
  if (!number || number.length < 8) {
    throw new Error(`Invalid phone number: "${to}"`);
  }
  return guardedSend(async () => {
    const numberId = await client.getNumberId(number);
    return { registered: Boolean(numberId), serialized: numberId ? numberId._serialized : null };
  });
}

// Send a document/media (e.g. a payslip PDF) with an optional caption.
// media = { base64, mimetype, filename, caption }
async function sendMedia(to, media) {
  if (!client || !isReady) {
    throw new Error('WhatsApp client is not ready');
  }
  const number = normalizeNumber(to);
  if (!number || number.length < 8) {
    throw new Error(`Invalid phone number: "${to}"`);
  }
  const { base64, mimetype, filename, caption } = media || {};
  if (!base64) {
    throw new Error('media.base64 is required');
  }
  const msgMedia = new MessageMedia(mimetype || 'application/pdf', base64, filename || 'document.pdf');
  return guardedSend(async () => {
    let chatId;
    if (config.verifyNumber) {
      const numberId = await client.getNumberId(number);
      if (!numberId) throw new Error(`Number ${number} is not registered on WhatsApp`);
      chatId = numberId._serialized;
    } else {
      chatId = `${number}@c.us`;
    }
    return client.sendMessage(chatId, msgMedia, { caption: caption || '' });
  });
}

// Periodic watchdog — the core of auto-recovery. Handles two failure modes
// that leave the bridge "up but not sending":
//   1. Stuck init: authenticated but the READY event never fires, and no QR
//      is being shown. After STUCK_MS, reinit. After MAX_STUCK_REINITS, wipe
//      the session so a fresh QR appears.
//   2. Dead session: isReady=true but the WhatsApp Web page is detached —
//      getState() throws or returns a non-CONNECTED state. Reinit.
function startWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(async () => {
    if (reinitializing) return;

    if (!isReady) {
      // Don't disturb a legitimate QR wait (user hasn't scanned yet).
      if (lastQr) return;
      const stuckFor = Date.now() - initStartedAt;
      if (initStartedAt && stuckFor > STUCK_MS) {
        stuckReinitCount += 1;
        const clearSession = stuckReinitCount > MAX_STUCK_REINITS;
        logger.warn(`[RECOVERY] not ready for ${Math.round(stuckFor / 1000)}s (stuck #${stuckReinitCount}).`);
        reinitialize('stuck init', { clearSession });
        if (clearSession) stuckReinitCount = 0;
      }
      return;
    }

    // isReady === true: verify the session is genuinely alive.
    try {
      const state = await client.getState();   // throws if the page is detached
      if (state && state !== 'CONNECTED') {
        logger.warn(`[RECOVERY] watchdog: state=${state} (not CONNECTED).`);
        isReady = false;
        reinitialize('watchdog state');
      }
    } catch (e) {
      logger.warn(`[RECOVERY] watchdog: getState failed (${e.message}).`);
      isReady = false;
      reinitialize('watchdog getState error');
    }
  }, WATCHDOG_MS);
}

function init() {
  initStartedAt = Date.now();
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });

  client.on('qr', async (qr) => {
    lastQr = qr;
    try {
      lastQrDataUrl = await QRCode.toDataURL(qr);
    } catch (err) {
      logger.error(`Failed to render QR image: ${err.message}`);
    }
    logger.warn(`QR received. Open http://localhost:${config.port}/qr in a browser, or scan from this terminal:`);
    qrcodeTerminal.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    logger.info('WhatsApp authenticated - session saved');
  });

  client.on('auth_failure', (msg) => {
    logger.error(`WhatsApp auth failure: ${msg}`);
  });

  client.on('ready', () => {
    isReady = true;
    lastQr = null;
    lastQrDataUrl = null;
    stuckReinitCount = 0;
    logger.info('WhatsApp client is READY');
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    logger.error(`WhatsApp disconnected: ${reason}.`);
    reinitialize(`disconnected: ${reason}`);
  });

  client.initialize().catch((err) => {
    logger.error(`WhatsApp initialize failed: ${err.message}`);
    if (isSessionError(err)) reinitialize('initialize error');
  });

  // Start the watchdog once (idempotent — clears any prior interval).
  startWatchdog();

  return client;
}

module.exports = { init, sendMessage, sendMedia, checkNumber, ready, getStatus, getQrDataUrl };
