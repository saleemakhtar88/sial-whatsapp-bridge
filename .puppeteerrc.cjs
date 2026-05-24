// Puppeteer cache location for the WhatsApp bridge.
//
// whatsapp-web.js drives a headless Chromium via puppeteer. When the bridge runs
// as a Windows service (LocalSystem), it can't see the Chromium that npm
// downloaded into the *installing user's* profile cache (~/.cache/puppeteer).
// To fix that, install-deps.bat downloads Chromium into a PROJECT-LOCAL cache
// (<project>\.cache\puppeteer), and this file points puppeteer there at runtime
// so the service finds it.
//
// If that local cache doesn't exist (e.g. a dev box that installed normally), we
// return {} so puppeteer falls back to its default location and nothing changes.
const { join } = require('path');
const fs = require('fs');

const localCache = join(__dirname, '.cache', 'puppeteer');
module.exports = fs.existsSync(localCache) ? { cacheDirectory: localCache } : {};
