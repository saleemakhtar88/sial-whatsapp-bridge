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
let logoutInProgress = false;  // set during manual logout — prevents the auto-recovery
                                // 'disconnected' handler from racing with our clearSession reinit

const STUCK_MS    = 90 * 1000;   // not-ready (no QR) longer than this → reinit
const WATCHDOG_MS = 60 * 1000;   // health-check interval
const MAX_STUCK_REINITS = 2;     // after this many stuck reinits, clear session → QR

function ready() {
  return isReady;
}

function getStatus() {
  // Include the QR image (data URL) while we're waiting to be linked, so a
  // caller (e.g. the SIAL portal) can render it through its own origin instead
  // of needing direct access to this bridge's localhost port. Omitted once
  // ready, to keep the health payload small when connected.
  return { ready: isReady, hasQr: Boolean(lastQr), qrDataUrl: isReady ? null : (lastQrDataUrl || null) };
}

async function getQrDataUrl() {
  return lastQrDataUrl;
}

function normalizeNumber(raw) {
  let d = String(raw).replace(/\D/g, '');     // keep digits only
  if (d.startsWith('00')) d = d.slice(2);      // 0092… (intl prefix) -> 92…
  if (d.startsWith('0')) d = '92' + d.slice(1); // 0333… (PK local) -> 92333…
  else if (d.length === 10) d = '92' + d;       // 3338685105 -> 923338685105
  return d;
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
  const clientOpts = {
    authStrategy: new LocalAuth({ dataPath: config.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      // Media (image) sends can exceed Puppeteer's default 180s protocol timeout
      // and die with "Runtime.callFunctionOn timed out". Give them more room.
      protocolTimeout: Number(process.env.PROTOCOL_TIMEOUT_MS) || 600000,
    },
  };
  // Optional: pin a specific WhatsApp Web version (set WA_WEB_VERSION in .env).
  // Use this if linking fails with "couldn't link device" because WhatsApp's
  // live web build broke the installed whatsapp-web.js. The version HTML is
  // served from the wppconnect wa-version mirror.
  if (config.webVersion) {
    clientOpts.webVersion = config.webVersion;
    clientOpts.webVersionCache = {
      type: 'remote',
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${config.webVersion}.html`,
    };
    logger.warn(`[CONFIG] Pinning WhatsApp Web version ${config.webVersion}`);
  }
  client = new Client(clientOpts);

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
    // During a manual logout, our own logout() flow drives the reinit (with
    // clearSession=true) — don't double-trigger from here.
    if (logoutInProgress) {
      logger.warn(`[LOGOUT] disconnected during manual logout (${reason}) — letting logout() finish the reinit.`);
      return;
    }
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

// Manually unlink the currently-linked WhatsApp account so a different number
// can be paired (e.g. switching from a personal cell to a company line). Steps:
//   1. client.logout() — proper WhatsApp Web logout: invalidates the session
//      on the WhatsApp server so the phone's "Linked devices" no longer lists
//      this bridge. Best-effort; if it fails (session already dead) we keep going.
//   2. destroy() + wipe `.wwebjs_auth` so the next initialize() can't restore
//      the old session.
//   3. re-initialize() — fresh client, fresh QR. /health will start reporting
//      hasQr:true within a few seconds, ready:false until the new phone scans.
// Returns { ok: true } once the teardown is queued; the QR appears asynchronously.
async function logout() {
  logger.warn('[LOGOUT] manual logout requested — disconnecting & clearing saved session');
  logoutInProgress = true;
  if (client) {
    try {
      await client.logout();
      logger.info('[LOGOUT] client.logout() ok — session invalidated on WhatsApp side');
    } catch (e) {
      // Common when the session is already dead — just log and continue with
      // the local teardown so the bridge still ends up in a fresh-QR state.
      logger.warn('[LOGOUT] client.logout() threw (' + e.message + ') — continuing with local wipe');
    }
  }
  // Force a clean reinit even if some other recovery flow is mid-reinit.
  reinitializing = false;
  isReady = false;
  await reinitialize('manual logout', { clearSession: true });
  logoutInProgress = false;
  return { ok: true };
}

module.exports = { init, sendMessage, sendMedia, checkNumber, ready, getStatus, getQrDataUrl, logout };
