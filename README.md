# Status Monitor

A lightweight self-hosted website monitoring app — like a private version of `status.digitalocean.com`.
Tracks HTTP availability, SSL certificate health, response time, and redirects for any number of websites,
and optionally sends alerts via email and WhatsApp when something goes down.

## What it does

For every website you add, every 5 minutes (configurable), the app:

- Sends an HTTPS request and records the **status code**, **response time (ms)**, **redirect count**, and **final URL**.
- Inspects the **TLS certificate** — issuer, validity, days until expiry. A cert that's invalid or expired flips the site to "down" automatically.
- Optionally checks for an **expected keyword** in the page body (great for catching "white page of death" or maintenance pages that still return HTTP 200).
- Stores every check in SQLite, opens an **incident** when a site fails N consecutive checks, and closes it when the site recovers.
- Sends optional **email + WhatsApp alerts** when an incident opens (with a built-in cooldown so you're not spammed).

A public status page at `/` shows green/red per site, response time, SSL days remaining, and 24-hour uptime %.
An admin dashboard at `/admin` lets you add/remove sites, configure notifications, and review incident history.
There's also a JSON API at `/api/status` for embedding the data elsewhere.

## Tech stack

| Layer        | Choice                | Why                                                                 |
|--------------|----------------------|---------------------------------------------------------------------|
| Runtime      | **Node.js 18+**      | Native to Plesk's Node.js app feature.                              |
| Web          | **Express**          | Tiny, well-known, perfect for an admin app.                         |
| DB           | **SQLite** (better-sqlite3) | Zero-setup, single file in `data/monitor.db`. Easy to back up. |
| Templating   | **EJS**              | Server-rendered HTML, no build step required.                       |
| Auth         | **express-session** + **bcryptjs** | Hashed passwords, session cookie stored in SQLite.   |
| Scheduler    | **node-cron**        | Runs the monitoring sweep every 5 min.                              |
| Email        | **nodemailer**       | Standard SMTP.                                                      |
| WhatsApp     | **Twilio HTTP API**  | Easiest WhatsApp option that works in business contexts.            |

There is **no build step**. No webpack, no React, no compile. You upload the folder, run `npm install`, and start `app.js`. That's it.

## Local development

```bash
cd status-monitor
cp .env.example .env       # then edit with your values
npm install
npm start
```

Open http://localhost:3000 (public status page) and http://localhost:3000/login
(admin sign-in — uses `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` on first boot).

The 4 starter sites (Wirth Gruppe, Wirsol, Höffner, WPower) are seeded automatically on the first run.

## File layout

```
status-monitor/
├── app.js                  # Express entry point (Plesk uses this as the startup file)
├── package.json
├── .env.example            # Copy to .env and fill in
├── db/database.js          # SQLite schema + seed data
├── lib/
│   ├── monitor.js          # The actual website-checking logic (HTTP + TLS)
│   ├── notifier.js         # Email + WhatsApp delivery
│   └── scheduler.js        # cron-driven sweep
├── routes/
│   ├── public.js           # /  and /api/status
│   ├── auth.js             # /login, /logout
│   └── admin.js            # /admin/*
├── middleware/auth.js      # requireLogin
├── views/                  # EJS templates
├── public/css/style.css    # Plain CSS, no framework
└── data/                   # SQLite files (created on first boot, .gitignored)
```

## Configuration (`.env`)

| Variable | What it does |
|---|---|
| `PORT` | Port to listen on. On Plesk this is set automatically. |
| `SESSION_SECRET` | Long random string used to sign session cookies. **Change this.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Used **only on first boot** to create the admin account. After that, change the password from `/admin/account`. |
| `CHECK_CRON` | When to run sweeps. Default `*/5 * * * *` (every 5 minutes). |
| `ALERT_THRESHOLD` | How many consecutive failures before raising an incident + alert. Default `2`. |
| `ALERT_COOLDOWN_MINUTES` | Don't re-alert for the same site within this window. Default `60`. |
| `SMTP_*` | Standard SMTP credentials (host, port, user, pass, from). |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | Twilio credentials for WhatsApp. The "from" must be in the `whatsapp:+...` format. |

Recipient lists (which emails / phone numbers to alert) are stored in the database and edited from `/admin/settings` — they're not in `.env`.

## Deploying on Plesk (step by step)

> Plesk's "Node.js" feature wraps your app behind nginx+Phusion Passenger. You don't need to install Node.js manually if Plesk already has the Node.js extension installed.

1. **Upload the project.** In Plesk → Domains → *yourdomain* → File Manager, create a folder like `httpdocs/status` (or use a subdomain) and upload the entire `status-monitor` folder there. You can zip it locally and upload + extract.

2. **Enable Node.js.** Go to *Domains → yourdomain → Node.js*. Click **Enable Node.js** and set:
   - **Node.js version:** 18.x or 20.x.
   - **Application mode:** `production`.
   - **Document root:** the folder you uploaded to (e.g. `httpdocs/status`).
   - **Application root:** same as document root.
   - **Application startup file:** `app.js`.

3. **Install dependencies.** In the same Plesk Node.js panel, click **NPM install**. Plesk runs `npm install` in your app root.

4. **Set environment variables.** Still in the Plesk Node.js panel, scroll to **Custom environment variables** and add the keys from `.env.example` you actually need:
   - `SESSION_SECRET` (mandatory — paste a long random string)
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` (only matter on first boot)
   - `SMTP_*` if you want email alerts
   - `TWILIO_*` if you want WhatsApp alerts
   - `CHECK_CRON`, `ALERT_THRESHOLD`, `ALERT_COOLDOWN_MINUTES` if you want to override defaults
   Plesk injects these into the Node.js process — no `.env` file required on the server (you can still upload one if you prefer).

5. **Start the app.** Click **Restart App**. Wait a few seconds.

6. **Visit your site.**
   - Public status: `https://yourdomain.tld/` (or `/status/` if you used a subfolder).
   - Admin login: `/login` — sign in with the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set.
   - **Immediately** go to `/admin/account` and change the password.

7. **(Optional) Use a subdomain.** If you prefer `status.yourdomain.tld`, create a subdomain in Plesk and repeat steps 1–5 with that subdomain's document root.

8. **Back-ups.** The whole app state is in `data/monitor.db`. Back that file up (or include the `data/` folder in Plesk's regular backup).

### File permissions

Plesk runs the Node.js process as your subscription's system user. Make sure that user has write access to the `data/` directory (Plesk does this by default for files you upload).

### Behind the proxy

Plesk's Passenger sets `X-Forwarded-*` headers automatically; the app already calls `app.set('trust proxy', 1)` so cookies are set with the correct `secure` flag in production.

## Configuring WhatsApp (Twilio)

WhatsApp business messaging requires a Twilio account.

1. Sign up at [twilio.com](https://www.twilio.com/).
2. The fastest way to test is the **WhatsApp sandbox** — under *Messaging → Try it out → Send a WhatsApp message*. You'll get a number like `whatsapp:+14155238886`. Each recipient must opt in by sending the magic word from their phone (Twilio shows you the word).
3. Copy your **Account SID**, **Auth Token**, and the sandbox **From** number into your Plesk env vars as `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`.
4. Restart the Node.js app in Plesk so it picks up the new env vars.
5. In `/admin/settings`, tick "Send WhatsApp alerts", enter recipient phone numbers (international format, e.g. `+491701234567`), save, and click **Send test WhatsApp**.

For production use, you'll want to apply for a verified Twilio WhatsApp sender — the sandbox is fine for internal alerts to a small team.

## Configuring Email (SMTP)

Almost any SMTP provider works. Examples:

| Provider     | Host                     | Port | Secure |
|--------------|--------------------------|------|--------|
| Gmail (app password) | smtp.gmail.com   | 587  | false  |
| Microsoft 365 | smtp.office365.com      | 587  | false  |
| SendGrid     | smtp.sendgrid.net        | 587  | false  |
| Your Plesk mail | mail.yourdomain.tld   | 587  | false  |

Set the `SMTP_*` env vars, restart, then add recipients in `/admin/settings` and click **Send test email**.

## What "down" actually means

A site counts as **down** if any of these are true:
- The HTTP request errors out (DNS failure, connection refused, timeout, etc.).
- The status code doesn't match the expected one (default 200).
- An HTTPS site has an invalid or expired certificate.
- An "expected keyword" was configured but isn't found in the response body.

## Adjustable thresholds

- `ALERT_THRESHOLD=2` (default): one transient blip won't page you.
- `ALERT_COOLDOWN_MINUTES=60` (default): you won't get spammed if a site flaps.

## API

`GET /api/status` returns JSON with the latest snapshot for every enabled site:

```json
{
  "generated_at": "2026-05-06T14:00:00.000Z",
  "sites": [
    {
      "id": 1,
      "name": "Wirth Gruppe",
      "url": "https://wirthgruppe.com/",
      "is_up": true,
      "status_code": 200,
      "response_time_ms": 412,
      "ssl_valid": true,
      "ssl_days_remaining": 78,
      "ssl_expires_at": "2026-07-23T12:00:00.000Z",
      "last_checked_at": "2026-05-06T13:55:01",
      "uptime_24h_pct": 100.0,
      "error": null
    }
  ]
}
```

This is unauthenticated — keep it public if you want a Grafana/Notion/etc. card to read it; otherwise put a password in front of it via Plesk's "Password protected directories" feature.

## Security notes

- Initial admin password should be changed at `/admin/account` immediately after first login.
- Sessions are stored in `data/sessions.db` and survive restarts.
- Cookies are flagged `secure` when `NODE_ENV=production`.
- The DB file `data/monitor.db` is plain SQLite — back it up but don't expose it.
- The app trusts the reverse proxy (Plesk) for client IPs.

## Troubleshooting

- **"Cannot find module 'better-sqlite3'"** in Plesk → click **NPM install** in the Node.js panel.
- **"better-sqlite3 build failed"** → Plesk's Node.js usually ships prebuilt binaries; if not, ensure your Plesk has `python3` and `make` installed (or pick a different Node.js version that has prebuilt binaries available).
- **No checks appearing on the public page** → check the Plesk app log; the scheduler logs each sweep. If nothing logs, your `CHECK_CRON` may be invalid (it falls back to `*/5 * * * *`).
- **Email/WhatsApp test fails** → exact error appears as a flash message on the settings page. Most common: bad SMTP credentials, missing Twilio sandbox opt-in.

## License

Internal tool — use freely within your organization.
