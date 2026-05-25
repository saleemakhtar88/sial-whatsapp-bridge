const path = require('path');
require('dotenv').config();

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

module.exports = {
  port: num(process.env.PORT, 3100),
  apiKey: process.env.API_KEY || '',
  sessionPath: process.env.SESSION_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
  minDelayMs: num(process.env.MIN_DELAY_MS, 3000),
  maxDelayMs: num(process.env.MAX_DELAY_MS, 8000),
  maxRetries: num(process.env.MAX_RETRIES, 3),
  verifyNumber: bool(process.env.VERIFY_NUMBER, true),
  // Optional: pin a specific WhatsApp Web version (e.g. 2.3000.10xxxxxxx-alpha)
  // to work around "couldn't link device" when WhatsApp's live web build breaks
  // the installed whatsapp-web.js. Empty = let whatsapp-web.js choose.
  webVersion: process.env.WA_WEB_VERSION || '',
  logLevel: process.env.LOG_LEVEL || 'info',
};
