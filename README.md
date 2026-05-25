# SIAL WhatsApp Bridge (reusable WhatsApp API)

A small, standalone **HTTP service that sends WhatsApp messages and documents**, and checks whether a number is on WhatsApp. Built on [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) (which drives a headless Chromium logged into WhatsApp Web) + Express.

> **Reusing this for a new project?** This folder is meant to be the single source of truth.
> - **How to integrate** → this README (sections below).
> - **When something breaks** → [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) (every issue we hit + the fix — read it, it will save you hours).
> - **Deploy on Windows as a service** → [`DEPLOY.md`](DEPLOY.md).

---

## Why a separate service?

`whatsapp-web.js` keeps **one** logged-in browser session. Running it as its own always-on service means: **one QR scan, one session**, and any number of apps can send through it over a simple HTTP API — without each app embedding a 250 MB browser. Your app decides *what* to send; the bridge handles the messy job of *talking to WhatsApp*.

```
your app ──HTTP + x-api-key──▶ bridge (:3100) ──whatsapp-web.js──▶ WhatsApp
```

---

## Quick start (development)

Requires **Node.js LTS** (v20 / v22 / v24 — *not* v25; see TROUBLESHOOTING).

```bash
npm install                 # downloads ~250 MB Chromium (puppeteer)
cp .env.example .env        # then set a long random API_KEY
npm start                   # first run prints a QR
```

Open **http://localhost:3100/qr** and scan with the phone whose WhatsApp will send (WhatsApp → **Linked devices** → **Link a device**). The session is saved in `.wwebjs_auth/`, so restarts don't need a re-scan.

If the QR scan fails with **"couldn't link device"**, that's the version-drift issue — see TROUBLESHOOTING §1 (short version: set `WA_WEB_VERSION` to link, then unset it to send).

---

## HTTP API

All endpoints except `/health` and `/qr` require the header **`x-api-key: <API_KEY>`**.
`to` is digits-only international format, e.g. `923001234567` (the bridge also normalizes `0300…`, `+92…`, and bare 10-digit numbers).

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET`  | `/health` | — | `{ ready, hasQr, qrDataUrl, queued, uptimeSeconds }` — `qrDataUrl` is the QR image (data URL) while unlinked, `null` once connected |
| `GET`  | `/qr` | — | HTML page showing the QR (auto-refreshes) |
| `POST` | `/send` | `{ to, message }` | `{ success, status:"queued", id }` — queue a text message |
| `POST` | `/send-media` | `{ to, base64, mimetype?, filename?, caption? }` | queue a document (e.g. a PDF) |
| `POST` | `/check-number` | `{ to }` | `{ success, registered, serialized }` — is the number on WhatsApp? **No message sent** |

Sends are **queued** (one at a time) with a randomized delay (`MIN_DELAY_MS`–`MAX_DELAY_MS`) and retried up to `MAX_RETRIES`, so a burst looks human and survives transient errors. `/check-number` is a direct lookup (not queued) — pace it yourself.

### Examples
```bash
KEY=your-api-key

# text
curl -s -X POST http://localhost:3100/send \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"to":"923001234567","message":"Hello"}'

# document (base64 PDF)
curl -s -X POST http://localhost:3100/send-media \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"to":"923001234567","base64":"JVBERi0...","filename":"doc.pdf","caption":"Your file"}'

# is this number on WhatsApp? (no message sent)
curl -s -X POST http://localhost:3100/check-number \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"to":"923001234567"}'
```

---

## Integrating from another project (Node)

The bridge is just HTTP, so any language works. For Node (18+, has global `fetch`), drop this thin, dependency-free client into your project and set `WHATSAPP_API_URL` + `WHATSAPP_API_KEY` in its env (the key must MATCH the bridge's `API_KEY`):

```js
// whatsapp.js — thin client for the bridge. No dependencies (Node 18+).
const URL = (process.env.WHATSAPP_API_URL || 'http://localhost:3100').replace(/\/+$/, '');
const KEY = process.env.WHATSAPP_API_KEY || '';

async function post(path, body, ms = 15000) {
  const r = await fetch(`${URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false) return { ok: false, error: j.error || `HTTP ${r.status}` };
  return { ok: true, ...j };
}

const digits = n => String(n || '').replace(/\D/g, '');

module.exports = {
  async health() {
    try { const r = await fetch(`${URL}/health`, { signal: AbortSignal.timeout(4000) });
          return { ok: true, ...(await r.json()) }; }
    catch (e) { return { ok: false, error: `bridge unreachable (${e.message})` }; }
  },
  sendMessage:  (to, message)          => post('/send', { to: digits(to), message: String(message) }, 8000),
  sendDocument: (to, content, filename, caption, mimetype) => post('/send-media', {
                   to: digits(to),
                   base64: Buffer.isBuffer(content) ? content.toString('base64') : String(content),
                   mimetype: mimetype || 'application/pdf', filename: filename || 'document.pdf', caption: caption || '' }, 30000),
  checkNumber:  (to)                   => post('/check-number', { to: digits(to) }),
};
```
```js
const wa = require('./whatsapp');
await wa.sendMessage('923001234567', 'Hello');
await wa.sendDocument('923001234567', require('fs').readFileSync('doc.pdf'), 'doc.pdf', 'Your file');
const { registered } = await wa.checkNumber('923001234567');
```

A ready-made, packaged version of this client (plus a copy of this bridge and runnable examples) also lives in the **`whatsapp-integration`** repo.

### Pattern: "verify once, reuse" (avoid re-checking numbers on every send)
`/check-number` is a real WhatsApp lookup — don't run it on every send. Verify each number **once**, cache the result (a tiny table keyed by the number), and on future sends skip numbers you know aren't on WhatsApp. Keep the bridge's `VERIFY_NUMBER=false` when your app pre-verifies (otherwise it re-checks on every send). The SIAL app does exactly this.

---

## Configuration (`.env`)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3100` | HTTP port |
| `API_KEY` | — | **Required.** Shared secret; callers send it as `x-api-key`. Must match the caller's `WHATSAPP_API_KEY`. The service refuses to start if missing/placeholder. |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | `3000` / `8000` | Random delay between queued sends (ban-risk mitigation) |
| `MAX_RETRIES` | `3` | Retries per message before giving up |
| `VERIFY_NUMBER` | `false` | If `true`, the bridge runs `getNumberId` before each send. Keep `false` if the caller pre-verifies + caches (recommended). |
| `WA_WEB_VERSION` | *(unset)* | **Advanced.** Pin a WhatsApp Web build to fix "couldn't link". A build that *links* may not *send* — see TROUBLESHOOTING §1. Ship UNSET. |
| `SESSION_PATH` | `./.wwebjs_auth` | Where the logged-in session is stored |
| `LOG_LEVEL` | `info` | `error`/`warn`/`info`/`debug` |

---

## Auto-recovery (built in)

A watchdog (`src/whatsapp.js`) runs every 60 s and self-heals the two common "up but not sending" failures:
1. **Stuck init** — authenticated but never reaches READY, and no QR showing → reinitialize after 90 s. After 2 stuck reinits it clears `.wwebjs_auth` so a fresh QR appears.
2. **Dead session** — `ready` but the WhatsApp Web page detached (`getState()` throws / not `CONNECTED`) → reinitialize.

Fatal session errors during a send (`detached frame`, `target closed`, `protocol error`, …) also flag the client not-ready and trigger a reinit; the send queue pauses until it's healthy again.

---

## Deploy on Windows (NSSM service)

See **[`DEPLOY.md`](DEPLOY.md)**. In short: `install-deps.bat` → set `.env` `API_KEY` → `install-service.bat` (registers `SIALWhatsAppBridge`, auto-start) → scan the QR. `update.bat` pulls + restarts; `service-status.bat` shows health + logs.

The installer downloads Chromium into a **project-local** `.cache/` (via `.puppeteerrc.cjs`) so the LocalSystem service can find it — see TROUBLESHOOTING §3 for why that matters.

---

## Files

| File | Purpose |
|---|---|
| `src/server.js` | Express app + routes |
| `src/whatsapp.js` | whatsapp-web.js client, send/checkNumber, auto-recovery watchdog, version-pin |
| `src/queue.js` | randomized + retrying send queue |
| `src/config.js` | env config |
| `.puppeteerrc.cjs` | points puppeteer at a project-local Chromium cache (service-friendly) |
| `*.bat`, `DEPLOY.md` | Windows NSSM deployment kit |
| `TROUBLESHOOTING.md` | **every issue we hit + the fix** |
