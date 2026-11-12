# Orbit Messenger

A self-hosted, multi-user messaging app built with HTML, CSS, JavaScript, Python's standard library, and SQLite. Designed with a quiet, Linear-inspired dark interface. Developer credit: **KING_YOSEF_**.

## Run it in VS Code

1. Install Python 3.9 or newer if it is not already installed.
2. Open this folder in VS Code.
3. Run `python server.py` in the VS Code terminal, or double-click `start.bat` on Windows.
4. Open [http://localhost:8000](http://localhost:8000) on the host computer.
5. The first visitor creates an account. Each person registers with a unique username and password, then searches for another user's username and sends a request. The recipient accepts it under **People → Requests** before messaging is enabled.

The server listens on all network interfaces. To join from another device on the same Wi-Fi/LAN, find the host computer's IPv4 address (for example with `ipconfig` on Windows) and open `http://HOST-IP:8000` on the other device. Allow Python through the host's firewall for private networks if prompted. Do not port-forward this HTTP server to the public internet: use it on a trusted local network.

## Features

- Account registration and login with salted PBKDF2 password hashes
- Long-lived sign-in session and sign out
- Editable display name, username, and bio
- Uploadable profile pictures (stored with the account; resized before upload)
- Search by username or display name
- Incoming and outgoing friend requests, accept/decline, and connected-user list
- Persistent one-to-one text conversations, stored in SQLite
- Voice notes using the browser microphone, plus audio-file sending
- Create servers, invite others with a link/code, join servers, and chat in a shared `# general` room
- Polling keeps new messages and requests up to date across signed-in devices
- Responsive mobile layout

Existing Orbit databases are upgraded automatically the next time the server starts. Profile photos, server memberships, and server chat are stored in that same SQLite database.

Voice recording works on localhost and on HTTPS sites. Browsers generally block microphone access from an unencrypted LAN IP address, so on LAN use the voice-note button's audio-file option, or host behind HTTPS to record directly. Text messaging works over the local network.

## Data and privacy

The server creates `data/orbit.sqlite3` the first time it runs. It stores account records, password hashes, friendships, messages, and voice-note audio. Keep this file backed up to preserve the data. The database and Python files are blocked from static web access. This starter server uses plain HTTP for a trusted LAN and has no encryption in transit; do not expose it to an untrusted network.

No third-party packages or build step are required. Set `ORBIT_PORT` to use a different port, for example `ORBIT_PORT=8080 python server.py`.

## Deploy the full app on Cloudflare Workers

GitHub Pages can publish the static files, but it cannot run Orbit's API. Sign-in is deliberately disabled on the current GitHub Pages copy so it never sends passwords to a static host. The `worker.js` Cloudflare Worker serves the same frontend and implements the API against Turso, so the browser and API share one HTTPS origin. The original Python server remains available for local development.

1. Install Node.js, then run `npm install` in this folder.
2. Sign in to Cloudflare from your terminal with `npx wrangler login`.
3. Add `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` as Worker secrets with `npx wrangler secret put TURSO_DATABASE_URL` and `npx wrangler secret put TURSO_AUTH_TOKEN`. Enter each value only at the prompt; never put the token in this repository.
4. Run `npm run deploy` to build and publish Orbit.

Workers Free is the default plan and has usage limits; Cloudflare currently documents 100,000 requests per day. Requests beyond the free limit fail until the quota resets. Turso also has its own limits. Review both providers' current plan terms, do not select a paid plan, and do not add a payment method. Free tiers and terms can change, so no provider can guarantee free hosting forever.

For local development, `python server.py` continues to use `data/orbit.sqlite3`. The Cloudflare version requires the Turso URL and auth token as Worker secrets. Existing Turso databases are initialized and upgraded automatically on first API use.
