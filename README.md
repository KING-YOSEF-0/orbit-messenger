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

## Deploy on Render for free

The Render Blueprint uses its Free web service and a separate hosted Turso database. It needs `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` environment variables, set privately in Render and never committed to Git. Create a Turso database, copy its database URL and auth token, then choose **New → Blueprint** in Render and connect `KING-YOSEF-0/orbit-messenger`. Enter the two variables when Render prompts you. The Render service may sleep after inactivity and take about a minute to wake; its own local files are temporary, while account and chat data lives in Turso. Render documents these Free tier limits [here](https://render.com/docs/free). Turso lists a $0 Free plan with usage limits [here](https://turso.tech/pricing); keep database overages disabled so usage cannot turn into charges.

For local development, Orbit continues to use `data/orbit.sqlite3`. If `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are set, it instead connects to Turso. Render supplies the HTTP `PORT` environment variable automatically; locally, `ORBIT_PORT` remains supported.
