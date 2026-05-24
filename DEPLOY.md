# Deploying the SIAL WhatsApp Bridge (Windows)

The bridge is a small Node service (whatsapp-web.js + Express) that the SIAL Apps
server calls over HTTP to send WhatsApp messages / payslip PDFs and to check
which numbers are on WhatsApp. It owns one logged-in WhatsApp Web session.

Runs alongside the SIAL app on the same server. **Bridge = port 3100**, SIAL = 3020.

## Prerequisites
- **Node.js LTS** (v20 / v22 / v24). Non-LTS (e.g. v25) crashes as a service.
- **NSSM** — download from https://nssm.cc, put `nssm.exe` in `C:\nssm\`.
- **Git for Windows** (for `git clone` / `update.bat`).

## First-time install
```bat
cd /d "E:\AI Projects"
git clone https://github.com/saleemakhtar88/sial-whatsapp-bridge.git WhatsApp-Bridge
cd WhatsApp-Bridge

install-deps.bat
```
`install-deps.bat` installs packages and downloads Chromium into a **project-local**
cache (`.cache\puppeteer`) so the service can find it. It also creates `.env`.

**Edit `.env`** and set a real **`API_KEY`** (a long random string). It must MATCH
`WHATSAPP_API_KEY` in the SIAL app's `.env`. Keep `VERIFY_NUMBER=false`.

Then register the service (Administrator):
```bat
install-service.bat
```
It smoke-tests the bridge, grants the service account access, installs the
`SIALWhatsAppBridge` service (auto-start), and waits for it to come up. When it
reports **"waiting to be linked"**, open **http://localhost:3100/qr** and scan
with the company WhatsApp (WhatsApp -> Linked devices -> Link a device) — or use
the **"scan QR to link"** link on the SIAL payslip page.

## Point SIAL at the bridge
In the SIAL app's `.env` (`E:\AI Projects\SIAL-APPS\.env`):
```
WHATSAPP_API_URL=http://localhost:3100
WHATSAPP_API_KEY=<same value as the bridge's API_KEY>
```
Then restart SIAL: `net stop SIALAppsServer & net start SIALAppsServer`

## Day-to-day
- **Status / logs:** `service-status.bat`
- **Update to latest code:** `update.bat` (Administrator) — stops, `git pull`, restarts.
- **Remove the service:** `uninstall-service.bat` (keeps the saved session).
- Stop/start manually: `net stop SIALWhatsAppBridge` / `net start SIALWhatsAppBridge`

## Notes
- The saved session lives in `.wwebjs_auth\` (gitignored) — scan the QR once;
  restarts won't need a re-scan. It does **not** transfer between machines.
- The bridge auto-recovers from a stuck/dead session (watchdog reinitializes and,
  after repeated failures, clears the session so a fresh QR appears).
- `.env`, `node_modules\`, `.cache\`, `.wwebjs_auth\`, `.wwebjs_cache\`, `logs\`
  are all gitignored — `git pull` never touches them.
