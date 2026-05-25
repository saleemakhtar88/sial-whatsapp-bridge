# WhatsApp Bridge — Troubleshooting & Integration Lessons

Every real issue hit while building + deploying this bridge (and integrating it into the SIAL Apps payslip system), with the **cause** and the **fix**. If you're integrating WhatsApp into a new project, skim this first — most of these *will* bite you eventually.

Format: **Symptom → Cause → Fix.**

---

## 1. ⭐ "Couldn't link device — try again later" (QR scan fails)

This is the single most important one.

**Symptom:** The QR renders fine, but scanning it on the phone shows **"couldn't link device, try again later."** Existing sessions may also drop and refuse to reconnect.

**Cause: WhatsApp Web version drift.** `whatsapp-web.js` is written against a *specific* WhatsApp Web build. When WhatsApp's **live** build drifts too far ahead of the version your installed library targets, **fresh links fail** (internally it's a `LocalWebCache` "can't parse version" error).
- Find the version your library targets: `node_modules/whatsapp-web.js/src/util/Constants.js` → `webVersion`.
- Example seen 2026-05: **whatsapp-web.js 1.34.7 targets `2.3000.1017054665`**, but WhatsApp's live build had moved to ~`2.3000.1040…`. 1.34.7 was the *latest* release (nothing to upgrade to).

**Fix — the `WA_WEB_VERSION` pin, used as a two-step recipe:**
1. **To LINK:** set `WA_WEB_VERSION=<your lib's webVersion>` in `.env` (e.g. `2.3000.1017054665`) → restart → scan the QR. The bridge loads that exact build via `webVersionCache` (remote, from the [wppconnect-team/wa-version](https://github.com/wppconnect-team/wa-version) mirror) instead of the live page.
2. **To SEND:** once linked, **UNSET `WA_WEB_VERSION` → restart.** The bridge reconnects from the saved `.wwebjs_auth` session (no re-scan) on the live build, which **sends fine**. (See §2 for *why* you must unpin.)

**Before blaming version drift, rule these out** (we did):
- **Server clock** — must be accurate (and correct timezone). A skewed clock alone causes "couldn't link." `w32tm /resync /force`.
- **Network** — the bridge must reach WhatsApp. If `web.whatsapp.com` loads in a browser on that machine **and the QR rendered**, the network is fine (rendering the QR already required reaching WhatsApp).
- **Chromium** — if the QR appeared, Chromium launched fine.
- **Rate-limit** — "try again later" is *also* WhatsApp throttling after repeated failed scans. **Test with a spare number** to tell drift from a throttle. If a fresh number links instantly, your main number is just on cooldown — wait 30–60 min, stop spamming scans.

**When whatsapp-web.js ships a newer release:** `npm i whatsapp-web.js@latest`, then update `WA_WEB_VERSION` to its new bundled `webVersion` (or drop the pin) and re-test both link + send.

---

## 2. Pinned build LINKS but then can't SEND (minified "t" error)

**Symptom:** With `WA_WEB_VERSION` pinned (from §1), the QR links successfully, but **sending** a message/document throws a minified error like `t` (or sends silently fail).

**Cause:** The pinned (older) web build links OK, but its internal JS modules don't match what the library's *send* code expects — linking and sending exercise different internals.

**Fix:** **Pin only to link, then unpin to send** (the §1 recipe). The saved session in `.wwebjs_auth` survives the restart, so you scan once (pinned) and run normally (unpinned). `.env.example` ships UNSET for this reason.

> Lesson: **a web build that *links* may not *send*. Always test BOTH after changing `WA_WEB_VERSION`.**

---

## 3. "Could not find Chrome (ver. X…)" when running as a Windows service

**Symptom:** Works when you run `node src/server.js` yourself, but as a **Windows service** (NSSM/LocalSystem) puppeteer throws *"Could not find Chrome … cache path is `C:\Windows\system32\config\systemprofile\.cache\puppeteer`."* (This hit the **SIAL app's** payslip renderer too — any puppeteer-using app run as a service.)

**Cause:** `npm install` downloads Chrome into the **installing user's** profile cache (`C:\Users\<you>\.cache\puppeteer`). A service running as **LocalSystem** looks in *SYSTEM's* profile (`…\systemprofile\.cache\puppeteer`), which is empty.

**Fix A — project-local cache (what this bridge does; best for fresh deploys):**
- `.puppeteerrc.cjs` points puppeteer at `<project>/.cache/puppeteer`.
- `install-deps.bat` sets `PUPPETEER_CACHE_DIR=<project>\.cache\puppeteer` so Chrome downloads there.
- `install-service.bat` grants SYSTEM read+execute on the project (`icacls … /grant *S-1-5-18:(OI)(CI)RX /T`), so the service can launch it.

**Fix B — point an existing service at the user's cache (quick, no re-download):**
```cmd
C:\nssm\nssm.exe set <ServiceName> AppEnvironmentExtra PUPPETEER_CACHE_DIR=C:\Users\<user>\.cache\puppeteer
icacls "C:\Users\<user>\.cache\puppeteer" /grant "*S-1-5-18:(OI)(CI)RX" /T
net stop <ServiceName> & net start <ServiceName>
```
Confirm Chrome is actually there first: `dir /b /s "C:\Users\<user>\.cache\puppeteer\chrome" | findstr chrome.exe`.

> Note: page loads don't use puppeteer, so the app *seems* fine until the first render/send — then it fails.

---

## 4. `install-service.bat` dies: ". was unexpected at this time."

**Symptom:** A `.bat` prints its header then dies with `". was unexpected at this time."`.

**Cause:** **Unescaped parentheses in an `echo` *inside* a cmd `if (...)` / `for (...)` block.** cmd doesn't nest text parens — a bare `)` closes the block early. It fails even on a branch that doesn't execute (cmd parses the whole block first). Example culprit: `echo ... not on an LTS line (v20/v22/v24).` inside an `if`.

**Fix:** Inside a parenthesized block, **escape parens as `^(` `^)`** in echo text, **or reword to avoid them**, **or put the text in double quotes** (`"(Y/N)"` is fine).

---

## 5. `.bat` ". was unexpected at this time." even though the syntax is correct

**Symptom:** A `.bat` that *looks* fine fails on its first multi-line `if (...)` block — often after a fresh `git pull`/clone, or only on one machine.

**Cause:** **LF (Unix) line endings.** `cmd.exe` can't reliably parse multi-line parenthesized blocks when the file is LF.

**Fix:**
- `.gitattributes` with `*.bat text eol=crlf` (this repo has it) → fresh clones get CRLF.
- A **stale** working tree keeps LF (git won't rewrite unchanged files). Re-save as CRLF (PowerShell): `Get-ChildItem *.bat | %{ (Get-Content $_.FullName) | Set-Content $_.FullName }`.
- Or sidestep `.bat` entirely — the one-liner does the same as `update.bat`: `net stop <Service> & git pull & net start <Service>`.

---

## 6. `npm install` slow / hangs on the Chromium download (npm err 3221225786)

**Symptom:** `npm install` sits silently for 10+ min after the deprecation warnings; `3221225786` in the log = a `Ctrl+C` you pressed (0xC000013A).

**Cause:** puppeteer's ~250 MB Chromium download from Google's storage is slow/blocked from some regions (e.g. PK).

**Fix:** use the npmmirror CDN:
```cmd
npm config set registry https://registry.npmmirror.com
set PUPPETEER_DOWNLOAD_BASE_URL=https://npmmirror.com/mirrors/chrome-for-testing
```
then re-run (finishes in ~2 min). `install-deps.bat` auto-falls-back to this mirror if the default download **fails** — but a slow **hang** doesn't trigger the fallback, so set it up front when the network is slow. To check progress, watch the size of `node_modules` / `.cache\puppeteer` grow.

---

## 7. "Message queued but not received" / sends silently stop after hours

**Symptom:** `/send` returns `queued`, the recipient never gets it; `/health` may falsely show `ready:true`. Often after long uptime.

**Cause:** A **stale/dead WhatsApp Web session** (e.g. *"Attempted to use detached Frame"*) — the browser page died but `ready` wasn't cleared.

**Fix:** The built-in **auto-recovery watchdog** detects this (`getState()` throws / not `CONNECTED`, or a fatal session error during a send) and reinitializes; after repeated stuck reinits it clears `.wwebjs_auth` for a fresh QR. A manual restart fixes it immediately. (This is why the bridge runs as an auto-restart service, not a one-off script.)

---

## 8. Node version: service boots then exits with code 3

**Symptom:** As a Windows service the process starts, the boot banner appears in the log, then it exits with **code 3** and an empty stderr. Runs fine in the foreground.

**Cause:** **Non-LTS Node (e.g. v25).** It boots then exits when run as a service.

**Fix:** Use **Node LTS** (v20 / v22 / v24). `install-service.bat` warns on non-LTS. After changing Node major, wipe + reinstall `node_modules` (native modules are ABI-specific).

---

## 9. Ban risk (this is unofficial automation)

`whatsapp-web.js` drives WhatsApp Web; aggressive use **can get a number banned**. Mitigations baked in / recommended:
- **Pace sends** — the queue adds a random `MIN_DELAY_MS`–`MAX_DELAY_MS` gap; for big runs, send in **waves** from the caller (send N, pause, repeat).
- **Use a dedicated number**, not someone's primary personal WhatsApp.
- **`/check-number` is the riskiest bulk op** (mass lookups look like scraping). Do it **once**, cache the result, pace it (~1.5–3 s apart), and never on every send. It sends **no message** (recipients see nothing).
- Don't hammer the QR (repeated failed scans → temporary link throttling — see §1).

---

## 10. Misc

- **Number formats:** the bridge normalizes `0300…`, `0092…`, `+92…`, and bare 10-digit numbers to `92XXXXXXXXXX`. Callers can pass any of those.
- **Caller shows "WhatsApp: not configured":** the *calling app* is missing `WHATSAPP_API_KEY` in its `.env` (or the bridge is down). Set the key to match the bridge's `API_KEY`; start the bridge. ("not configured" ≠ "not linked" — a configured-but-unlinked bridge shows a QR / "connecting".)
- **`/send-media` 413 / payload too large:** base64 PDFs are big — the server allows 25 MB (`express.json({limit:'25mb'})`). Raise if needed.
- **Render a PDF behind an auth gate (caller side):** if your app renders a PDF with puppeteer from a login-gated page, the headless browser gets redirected to /login. Give the internal render request a shared header/token the auth middleware lets through (SIAL uses an `x-render-key`).

---

## Integration playbook (new project)

1. Run **one** bridge instance (this repo) as a service; scan the QR once.
2. In your app, copy the thin client from the [README](README.md) and set `WHATSAPP_API_URL` + `WHATSAPP_API_KEY` (key MUST match the bridge's `API_KEY`).
3. Keep the bridge's `VERIFY_NUMBER=false`; in your app, **verify each number once via `/check-number` and cache it**, then skip known-not-on-WhatsApp numbers on sends.
4. Pace bulk sends in waves; treat WhatsApp as best-effort (the client returns `{ok:false,error}` rather than throwing).
5. Deploy: Node **LTS**, project-local Chromium cache (§3), CRLF `.bat` (§5), auto-restart service.

## Quick reference — "WhatsApp suddenly stopped working"

| It says… | Look at… |
|---|---|
| "couldn't link device" on scan | §1 (version drift → pin to link / unpin to send) + clock + spare-number test |
| links but won't send / minified "t" | §2 (unpin) |
| "Could not find Chrome" | §3 (PUPPETEER_CACHE_DIR / project-local cache) |
| `.bat` ". was unexpected" | §4 (escaped parens) or §5 (CRLF) |
| `npm install` hangs on Chromium | §6 (npmmirror) |
| queued but not delivered | §7 (stale session → restart / watchdog) |
| service exits code 3 | §8 (use Node LTS) |
