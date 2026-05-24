const express = require('express');
const config = require('./config');
const logger = require('./logger');
const wa = require('./whatsapp');
const SendQueue = require('./queue');

if (!config.apiKey || config.apiKey === 'change-me-to-a-long-random-secret') {
  logger.error('API_KEY is missing or still the placeholder in .env - refusing to start. Set a long random API_KEY.');
  process.exit(1);
}

const app = express();
// PDFs arrive base64-encoded in the JSON body, so allow a larger payload.
app.use(express.json({ limit: '25mb' }));

const queue = new SendQueue({
  sender: wa.sendMessage,
  mediaSender: wa.sendMedia,
  isReady: wa.ready,
  minDelayMs: config.minDelayMs,
  maxDelayMs: config.maxDelayMs,
  maxRetries: config.maxRetries,
});

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key');
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ success: false, error: 'Invalid or missing x-api-key' });
  }
  return next();
}

// Health check - no auth, safe for monitoring.
app.get('/health', (req, res) => {
  const status = wa.getStatus();
  res.json({
    success: true,
    ready: status.ready,
    hasQr: status.hasQr,
    qrDataUrl: status.qrDataUrl || null,
    queued: queue.size(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// First-time login QR - no auth, only useful before the client is ready.
app.get('/qr', async (req, res) => {
  if (wa.ready()) {
    return res.send('<h2 style="font-family:sans-serif">Already logged in</h2>');
  }
  const dataUrl = await wa.getQrDataUrl();
  if (!dataUrl) {
    return res.send('<h2 style="font-family:sans-serif">No QR yet - wait a few seconds and refresh.</h2>');
  }
  return res.send(
    `<html><body style="text-align:center;font-family:sans-serif;padding-top:30px">
       <h2>Scan with WhatsApp &rarr; Linked Devices</h2>
       <img src="${dataUrl}" style="width:320px;height:320px"/>
       <p>Page auto-refreshes every 20s</p>
       <script>setTimeout(function(){location.reload();},20000);</script>
     </body></html>`
  );
});

// Send a WhatsApp message. Protected by x-api-key.
// Body: { "to": "923001234567", "message": "Hello" }
app.post('/send', requireApiKey, (req, res) => {
  const { to, message } = req.body || {};
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'Both "to" and "message" are required' });
  }
  const id = queue.enqueue(String(to), String(message));
  return res.status(202).json({ success: true, status: 'queued', id, ready: wa.ready() });
});

// Send a document (e.g. a payslip PDF). Protected by x-api-key.
// Body: { "to": "923...", "base64": "...", "mimetype": "application/pdf",
//         "filename": "Payslip.pdf", "caption": "..." }
app.post('/send-media', requireApiKey, (req, res) => {
  const { to, base64, mimetype, filename, caption } = req.body || {};
  if (!to || !base64) {
    return res.status(400).json({ success: false, error: 'Both "to" and "base64" are required' });
  }
  const id = queue.enqueueMedia(String(to), {
    base64: String(base64),
    mimetype: mimetype || 'application/pdf',
    filename: filename || 'document.pdf',
    caption: caption || '',
  });
  return res.status(202).json({ success: true, status: 'queued', id, ready: wa.ready() });
});

// Check whether a number is on WhatsApp — NO message is sent. Protected by
// x-api-key. This is a direct lookup (not queued); the caller paces the loop.
// Body: { "to": "923..." }  ->  { success, registered, serialized }
app.post('/check-number', requireApiKey, async (req, res) => {
  const { to } = req.body || {};
  if (!to) {
    return res.status(400).json({ success: false, error: '"to" is required' });
  }
  if (!wa.ready()) {
    return res.status(503).json({ success: false, error: 'WhatsApp client is not ready' });
  }
  try {
    const r = await wa.checkNumber(String(to));
    return res.json({ success: true, registered: r.registered, serialized: r.serialized });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(config.port, () => {
  logger.info(`WhatsApp bridge listening on http://localhost:${config.port}`);
  logger.info(`First-time login: open http://localhost:${config.port}/qr and scan with your alternate number`);
  wa.init();
});
