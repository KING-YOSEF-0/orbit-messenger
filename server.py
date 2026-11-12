#!/usr/bin/env python3
"""Orbit messenger: small, self-hosted Python + SQLite chat server."""
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("ORBIT_DATA_DIR", str(ROOT / "data")))
DB_PATH = DATA_DIR / "orbit.sqlite3"
TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL", "").strip()
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN", "").strip()
PORT = int(os.environ.get("PORT", os.environ.get("ORBIT_PORT", "8000")))
HOST = os.environ.get("ORBIT_HOST", "0.0.0.0")
MAX_BODY = 12 * 1024 * 1024
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,24}$")

try:
    import turso_serverless
except ImportError:
    turso_serverless = None

INTEGRITY_ERRORS = (sqlite3.IntegrityError,)
if turso_serverless is not None and hasattr(turso_serverless, "IntegrityError"):
    INTEGRITY_ERRORS += (turso_serverless.IntegrityError,)


class TursoRow(dict):
    """Mapping-style row compatible with Orbit's sqlite3.Row lookups."""

    def __init__(self, names, values):
        super().__init__(zip(names, values))


class TursoCursor:
    def __init__(self, cursor):
        self.cursor = cursor
        self.names = [column[0] for column in (cursor.description or ())]

    def _row(self, row):
        if row is None:
            return None
        if hasattr(row, "keys"):
            return TursoRow(row.keys(), (row[key] for key in row.keys()))
        return TursoRow(self.names, row)

    def fetchone(self):
        return self._row(self.cursor.fetchone())

    def fetchall(self):
        return [self._row(row) for row in self.cursor.fetchall()]

    def __iter__(self):
        return (self._row(row) for row in self.cursor)

    @property
    def lastrowid(self):
        return self.cursor.lastrowid


class TursoConnection:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, parameters=()):
        return TursoCursor(self.connection.execute(sql, parameters))

    def commit(self):
        self.connection.commit()

    def rollback(self):
        self.connection.rollback()

    def close(self):
        self.connection.close()


@contextmanager
def db():
    if TURSO_DATABASE_URL:
        if not TURSO_AUTH_TOKEN:
            raise RuntimeError("TURSO_AUTH_TOKEN is required when TURSO_DATABASE_URL is set.")
        if turso_serverless is None:
            raise RuntimeError("Install requirements.txt to use the hosted database.")
        conn = TursoConnection(turso_serverless.connect(TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN))
    else:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=15)
    if not TURSO_DATABASE_URL:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with db() as c:
        schema = """
        CREATE TABLE IF NOT EXISTS users(
          id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
          display_name TEXT NOT NULL, password_hash TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL, avatar BLOB, avatar_mime TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions(
          token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS friendships(
          id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
          created_at INTEGER NOT NULL, UNIQUE(sender_id,recipient_id)
        );
        CREATE TABLE IF NOT EXISTS messages(
          id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL DEFAULT '', audio BLOB, audio_mime TEXT, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS msg_pair_time ON messages(sender_id,recipient_id,created_at);
        CREATE INDEX IF NOT EXISTS msg_recipient ON messages(recipient_id,created_at);
        CREATE TABLE IF NOT EXISTS servers(
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, invite_code TEXT NOT NULL UNIQUE,
          owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS server_members(
          server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at INTEGER NOT NULL, PRIMARY KEY(server_id,user_id)
        );
        CREATE TABLE IF NOT EXISTS server_messages(
          id INTEGER PRIMARY KEY, server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          text TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS server_msg_time ON server_messages(server_id,id);
        """
        for statement in schema.split(";"):
            if statement.strip():
                c.execute(statement)
        # Upgrade databases created by earlier Orbit versions.
        user_columns = {row["name"] for row in c.execute("PRAGMA table_info(users)")}
        if "avatar" not in user_columns:
            c.execute("ALTER TABLE users ADD COLUMN avatar BLOB")
        if "avatar_mime" not in user_columns:
            c.execute("ALTER TABLE users ADD COLUMN avatar_mime TEXT")


def user_json(row):
    keys = row.keys()
    has_avatar = bool(row["has_avatar"]) if "has_avatar" in keys else bool(row["avatar"]) if "avatar" in keys else False
    return {"id": row["id"], "username": row["username"], "displayName": row["display_name"], "bio": row["bio"], "hasAvatar": has_avatar}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args))

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > MAX_BODY:
            raise ValueError("Request is too large (12 MB limit).")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw)
        except Exception:
            raise ValueError("Request must contain valid JSON.")

    def auth(self, allow_query=False):
        token = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if not token and allow_query:
            token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        if not token:
            return None
        with db() as c:
            row = c.execute("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?", (token, int(time.time()))).fetchone()
        return (token, row) if row else None

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        avatar_match = re.fullmatch(r"/api/avatar/(\d+)", path)
        if avatar_match:
            auth = self.auth(allow_query=True)
            if not auth:
                return self.send_json({"error": "Please sign in."}, 401)
            with db() as c:
                row = c.execute("SELECT avatar,avatar_mime FROM users WHERE id=?", (int(avatar_match.group(1)),)).fetchone()
            if not row or not row["avatar"]:
                return self.send_error(404)
            self.send_response(200)
            self.send_header("Content-Type", row["avatar_mime"] or "image/jpeg")
            self.send_header("Content-Length", str(len(row["avatar"])))
            self.send_header("Cache-Control", "private, max-age=300")
            self.end_headers()
            self.wfile.write(row["avatar"])
            return
        if path.startswith("/api/media/"):
            auth = self.auth(allow_query=True)
            if not auth:
                return self.send_json({"error": "Please sign in."}, 401)
            try:
                msg_id = int(path.rsplit("/", 1)[1])
            except ValueError:
                return self.send_json({"error": "Not found."}, 404)
            me = auth[1]["id"]
            with db() as c:
                row = c.execute("SELECT audio,audio_mime,sender_id,recipient_id FROM messages WHERE id=? AND audio IS NOT NULL", (msg_id,)).fetchone()
            if not row or me not in (row["sender_id"], row["recipient_id"]):
                return self.send_json({"error": "Not found."}, 404)
            self.send_response(200)
            self.send_header("Content-Type", row["audio_mime"] or "audio/webm")
            self.send_header("Content-Length", str(len(row["audio"])))
            self.send_header("Cache-Control", "private, no-store")
            self.end_headers()
            self.wfile.write(row["audio"])
            return
        if not path.startswith("/api/"):
            # Keep the SQLite database, credentials source, and implementation files
            # private even though the same handler serves the front-end assets.
            target = (ROOT / path.lstrip("/")).resolve()
            try:
                parts = target.relative_to(ROOT).parts
            except ValueError:
                return self.send_error(404)
            private_dir = bool(parts) and parts[0].lower() in {"data", ".git", ".agents", ".codex"}
            if private_dir or target.suffix.lower() in {".sqlite", ".sqlite3", ".db", ".py", ".pyc"}:
                return self.send_error(404)
            return super().do_GET()
        auth = self.auth()
        try:
            if path == "/api/me":
                return self.send_json({"user": user_json(auth[1])} if auth else {"user": None})
            if not auth:
                return self.send_json({"error": "Please sign in."}, 401)
            me = auth[1]["id"]
            with db() as c:
                if path == "/api/people":
                    query = parse_qs(urlparse(self.path).query).get("q", [""])[0].strip().lstrip("@").lower()
                    if len(query) < 2:
                        return self.send_json({"people": []})
                    rows = c.execute("""SELECT u.* FROM users u WHERE u.id<>? AND (lower(u.username) LIKE ? OR lower(u.display_name) LIKE ?) ORDER BY CASE WHEN lower(u.username)=? THEN 0 ELSE 1 END, u.username COLLATE NOCASE LIMIT 30""", (me, query + "%", "%" + query + "%", query)).fetchall()
                    relations = c.execute("SELECT sender_id,recipient_id,status FROM friendships WHERE sender_id=? OR recipient_id=?", (me, me)).fetchall()
                    rel = {r["sender_id"] if r["recipient_id"] == me else r["recipient_id"]: {"status": r["status"], "incoming": r["recipient_id"] == me} for r in relations}
                    result = []
                    for row in rows:
                        person = user_json(row)
                        person["relationship"] = rel.get(row["id"], {}).get("status", "none")
                        person["incoming"] = rel.get(row["id"], {}).get("incoming", False)
                        result.append(person)
                    return self.send_json({"people": result})
                if path == "/api/requests":
                    rows = c.execute("SELECT u.* FROM friendships f JOIN users u ON u.id=f.sender_id WHERE f.recipient_id=? AND f.status='pending' ORDER BY f.created_at DESC", (me,)).fetchall()
                    return self.send_json({"requests": [user_json(r) for r in rows]})
                if path == "/api/conversations":
                    rows = c.execute("""SELECT u.id,u.username,u.display_name,u.bio,u.avatar IS NOT NULL AS has_avatar,m.text,m.audio IS NOT NULL AS has_audio,m.created_at,m.sender_id,m.id AS message_id FROM friendships f JOIN users u ON u.id=CASE WHEN f.sender_id=? THEN f.recipient_id ELSE f.sender_id END LEFT JOIN messages m ON m.id=(SELECT id FROM messages x WHERE (x.sender_id=? AND x.recipient_id=u.id) OR (x.sender_id=u.id AND x.recipient_id=?) ORDER BY x.id DESC LIMIT 1) WHERE f.status='accepted' AND (f.sender_id=? OR f.recipient_id=?) ORDER BY COALESCE(m.id,0) DESC,u.username COLLATE NOCASE""", (me, me, me, me, me)).fetchall()
                    return self.send_json({"conversations": [{**user_json(r), "lastMessage": "Voice note" if r["has_audio"] and not r["text"] else r["text"], "time": r["created_at"]} for r in rows]})
                if path == "/api/servers":
                    rows = c.execute("""SELECT s.id,s.name,s.invite_code,s.owner_id,COUNT(DISTINCT sm.user_id) AS member_count FROM server_members mine JOIN servers s ON s.id=mine.server_id JOIN server_members sm ON sm.server_id=s.id WHERE mine.user_id=? GROUP BY s.id ORDER BY s.id DESC""", (me,)).fetchall()
                    return self.send_json({"servers": [{"id":r["id"],"name":r["name"],"inviteCode":r["invite_code"],"ownerId":r["owner_id"],"memberCount":r["member_count"]} for r in rows]})
                server_match = re.fullmatch(r"/api/servers/(\d+)(?:/messages)?", path)
                if server_match:
                    server_id = int(server_match.group(1))
                    if not c.execute("SELECT 1 FROM server_members WHERE server_id=? AND user_id=?", (server_id, me)).fetchone():
                        return self.send_json({"error":"You are not a member of this server."}, 403)
                    if path.endswith("/messages"):
                        rows = c.execute("""SELECT m.id,m.text,m.created_at,m.user_id,u.username,u.display_name,u.avatar IS NOT NULL AS has_avatar FROM server_messages m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.id DESC LIMIT 250""", (server_id,)).fetchall()
                        result = [{"id":r["id"],"text":r["text"],"createdAt":r["created_at"],"user":{"id":r["user_id"],"username":r["username"],"displayName":r["display_name"],"hasAvatar":bool(r["has_avatar"])}} for r in reversed(rows)]
                        return self.send_json({"messages":result})
                    row = c.execute("SELECT s.id,s.name,s.invite_code,s.owner_id,COUNT(sm.user_id) AS member_count FROM servers s JOIN server_members mine ON mine.server_id=s.id LEFT JOIN server_members sm ON sm.server_id=s.id WHERE s.id=? AND mine.user_id=? GROUP BY s.id", (server_id,me)).fetchone()
                    return self.send_json({"server":{"id":row["id"],"name":row["name"],"inviteCode":row["invite_code"],"ownerId":row["owner_id"],"memberCount":row["member_count"]}})
                match = re.fullmatch(r"/api/messages/(\d+)", path)
                if match:
                    other = int(match.group(1))
                    if not c.execute("SELECT 1 FROM friendships WHERE status='accepted' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))", (me, other, other, me)).fetchone():
                        return self.send_json({"messages": [], "allowed": False})
                    rows = c.execute("SELECT m.id,m.sender_id,m.recipient_id,m.text,m.audio IS NOT NULL AS has_audio,m.created_at,u.username,u.display_name,u.bio,u.avatar IS NOT NULL AS has_avatar FROM messages m JOIN users u ON u.id=m.sender_id WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?) ORDER BY m.id DESC LIMIT 200", (me, other, other, me)).fetchall()
                    result = []
                    for r in reversed(rows):
                        item = {"id": r["id"], "senderId": r["sender_id"], "text": r["text"], "createdAt": r["created_at"], "sender": {"id":r["sender_id"],"username": r["username"], "displayName": r["display_name"],"bio":r["bio"],"hasAvatar":bool(r["has_avatar"])}}
                        if r["has_audio"]:
                            item["audioUrl"] = f"/api/media/{r['id']}?token={auth[0]}"
                        result.append(item)
                    return self.send_json({"messages": result, "allowed": True})
            return self.send_json({"error": "Endpoint not found."}, 404)
        except Exception as e:
            return self.send_json({"error": "Server error: " + str(e)}, 500)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            data = self.body()
        except ValueError as e:
            return self.send_json({"error": str(e)}, 413)
        try:
            if path in ("/api/register", "/api/login"):
                username = str(data.get("username", "")).strip()
                password = str(data.get("password", ""))
                if not USERNAME_RE.fullmatch(username):
                    return self.send_json({"error": "Username must be 3–24 characters: letters, numbers, or underscores."}, 400)
                if len(password) < 8:
                    return self.send_json({"error": "Password must be at least 8 characters."}, 400)
                with db() as c:
                    if path.endswith("register"):
                        display = str(data.get("displayName") or username).strip()[:32]
                        if not display:
                            display = username
                        salt = secrets.token_bytes(16)
                        hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 260000)
                        try:
                            cur = c.execute("INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)", (username, display, salt.hex() + ":" + hashed.hex(), int(time.time())))
                        except INTEGRITY_ERRORS:
                            return self.send_json({"error": "That username is already taken."}, 409)
                        uid = cur.lastrowid
                    else:
                        row = c.execute("SELECT * FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
                        if not row:
                            return self.send_json({"error": "Username or password is incorrect."}, 401)
                        salt_hex, expected = row["password_hash"].split(":", 1)
                        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 260000).hex()
                        if not hmac.compare_digest(actual, expected):
                            return self.send_json({"error": "Username or password is incorrect."}, 401)
                        uid = row["id"]
                    token = secrets.token_urlsafe(32)
                    c.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)", (token, uid, int(time.time()) + 60 * 60 * 24 * 30))
                    user = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
                return self.send_json({"token": token, "user": user_json(user)})
            auth = self.auth()
            if not auth:
                return self.send_json({"error": "Please sign in."}, 401)
            me = auth[1]["id"]
            with db() as c:
                if path == "/api/logout":
                    c.execute("DELETE FROM sessions WHERE token=?", (auth[0],))
                    return self.send_json({"ok": True})
                if path == "/api/servers":
                    name = str(data.get("name", "")).strip()[:40]
                    if len(name) < 2:
                        return self.send_json({"error":"Server name must be at least 2 characters."}, 400)
                    code = secrets.token_urlsafe(7).replace("-", "").replace("_", "")[:9].upper()
                    cur = c.execute("INSERT INTO servers(name,invite_code,owner_id,created_at) VALUES(?,?,?,?)", (name,code,me,int(time.time())))
                    server_id = cur.lastrowid
                    c.execute("INSERT INTO server_members(server_id,user_id,joined_at) VALUES(?,?,?)", (server_id,me,int(time.time())))
                    return self.send_json({"server":{"id":server_id,"name":name,"inviteCode":code,"ownerId":me,"memberCount":1}}, 201)
                if path == "/api/servers/join":
                    code = str(data.get("inviteCode", "")).strip().upper()
                    server = c.execute("SELECT * FROM servers WHERE invite_code=?", (code,)).fetchone()
                    if not server:
                        return self.send_json({"error":"That invite code was not found."}, 404)
                    c.execute("INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES(?,?,?)", (server["id"],me,int(time.time())))
                    count = c.execute("SELECT COUNT(*) AS count FROM server_members WHERE server_id=?", (server["id"],)).fetchone()["count"]
                    return self.send_json({"server":{"id":server["id"],"name":server["name"],"inviteCode":server["invite_code"],"ownerId":server["owner_id"],"memberCount":count}})
                server_message_match = re.fullmatch(r"/api/servers/(\d+)/messages", path)
                if server_message_match:
                    server_id = int(server_message_match.group(1))
                    text = str(data.get("text", "")).strip()[:4000]
                    if not text:
                        return self.send_json({"error":"Write a message first."}, 400)
                    if not c.execute("SELECT 1 FROM server_members WHERE server_id=? AND user_id=?", (server_id,me)).fetchone():
                        return self.send_json({"error":"Join this server before sending messages."}, 403)
                    cur = c.execute("INSERT INTO server_messages(server_id,user_id,text,created_at) VALUES(?,?,?,?)", (server_id,me,text,int(time.time())))
                    return self.send_json({"ok":True,"id":cur.lastrowid}, 201)
                if path == "/api/requests":
                    username = str(data.get("username", "")).strip().lstrip("@")
                    target = c.execute("SELECT id FROM users WHERE username=? COLLATE NOCASE", (username,)).fetchone()
                    if not target:
                        return self.send_json({"error": "No account found with that username."}, 404)
                    if target["id"] == me:
                        return self.send_json({"error": "You cannot send a request to yourself."}, 400)
                    existing = c.execute("SELECT * FROM friendships WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)", (me, target["id"], target["id"], me)).fetchone()
                    if existing:
                        if existing["status"] == "accepted": return self.send_json({"error": "You are already connected."}, 409)
                        if existing["recipient_id"] == me: return self.send_json({"error": "This person already sent you a request. Accept it in People → Requests."}, 409)
                        return self.send_json({"error": "Request already sent."}, 409)
                    c.execute("INSERT INTO friendships(sender_id,recipient_id,status,created_at) VALUES(?,?, 'pending',?)", (me, target["id"], int(time.time())))
                    return self.send_json({"ok": True})
                if path == "/api/messages":
                    target = int(data.get("recipientId", 0))
                    text = str(data.get("text", "")).strip()[:4000]
                    audio = None
                    audio_mime = None
                    encoded = data.get("audioData")
                    if encoded:
                        if not isinstance(encoded, str) or len(encoded) > 10_000_000:
                            return self.send_json({"error": "Voice note is too large (7 MB limit)."}, 413)
                        try: audio = base64.b64decode(encoded, validate=True)
                        except Exception: return self.send_json({"error": "Invalid audio data."}, 400)
                        audio_mime = str(data.get("audioMime", "audio/webm"))[:80]
                        if not audio_mime.startswith("audio/"):
                            return self.send_json({"error": "Please choose an audio file."}, 400)
                    if not text and audio is None:
                        return self.send_json({"error": "Write a message or attach a voice note."}, 400)
                    if not c.execute("SELECT 1 FROM friendships WHERE status='accepted' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))", (me, target, target, me)).fetchone():
                        return self.send_json({"error": "You can message this person after they accept your request."}, 403)
                    cur = c.execute("INSERT INTO messages(sender_id,recipient_id,text,audio,audio_mime,created_at) VALUES(?,?,?,?,?,?)", (me, target, text, audio, audio_mime, int(time.time())))
                    return self.send_json({"ok": True, "id": cur.lastrowid})
            return self.send_json({"error": "Endpoint not found."}, 404)
        except (TypeError, ValueError):
            return self.send_json({"error": "Invalid request."}, 400)
        except Exception as e:
            return self.send_json({"error": "Server error: " + str(e)}, 500)

    def do_PATCH(self):
        path = unquote(urlparse(self.path).path)
        auth = self.auth()
        if not auth:
            return self.send_json({"error": "Please sign in."}, 401)
        try:
            data = self.body()
            me = auth[1]["id"]
            if path == "/api/profile":
                username = str(data.get("username", "")).strip()
                display = str(data.get("displayName", "")).strip()[:32]
                bio = str(data.get("bio", "")).strip()[:160]
                if not USERNAME_RE.fullmatch(username): return self.send_json({"error": "Username must be 3–24 characters: letters, numbers, or underscores."}, 400)
                if not display: return self.send_json({"error": "Display name cannot be empty."}, 400)
                avatar = None
                avatar_mime = None
                if data.get("removeAvatar"):
                    avatar_mime = ""
                elif data.get("avatarData"):
                    encoded = data["avatarData"]
                    avatar_mime = str(data.get("avatarMime", ""))
                    if not isinstance(encoded, str) or len(encoded) > 2_800_000:
                        return self.send_json({"error":"Profile image must be smaller than 2 MB."}, 413)
                    if avatar_mime not in {"image/jpeg","image/png","image/webp","image/gif"}:
                        return self.send_json({"error":"Choose a JPG, PNG, WEBP, or GIF image."}, 400)
                    try: avatar = base64.b64decode(encoded, validate=True)
                    except Exception: return self.send_json({"error":"Invalid profile image."}, 400)
                    if len(avatar) > 2 * 1024 * 1024:
                        return self.send_json({"error":"Profile image must be smaller than 2 MB."}, 413)
                with db() as c:
                    try:
                        if data.get("removeAvatar"):
                            c.execute("UPDATE users SET username=?,display_name=?,bio=?,avatar=NULL,avatar_mime=NULL WHERE id=?", (username, display, bio, me))
                        elif avatar is not None:
                            c.execute("UPDATE users SET username=?,display_name=?,bio=?,avatar=?,avatar_mime=? WHERE id=?", (username, display, bio, avatar, avatar_mime, me))
                        else:
                            c.execute("UPDATE users SET username=?,display_name=?,bio=? WHERE id=?", (username, display, bio, me))
                    except INTEGRITY_ERRORS:
                        return self.send_json({"error": "That username is already taken."}, 409)
                    user = c.execute("SELECT * FROM users WHERE id=?", (me,)).fetchone()
                return self.send_json({"user": user_json(user)})
            match = re.fullmatch(r"/api/requests/(\d+)", path)
            if match:
                sender = int(match.group(1))
                action = data.get("action")
                with db() as c:
                    req = c.execute("SELECT * FROM friendships WHERE sender_id=? AND recipient_id=? AND status='pending'", (sender, me)).fetchone()
                    if not req: return self.send_json({"error": "That request is no longer pending."}, 404)
                    if action == "accept": c.execute("UPDATE friendships SET status='accepted' WHERE id=?", (req["id"],))
                    elif action == "decline": c.execute("DELETE FROM friendships WHERE id=?", (req["id"],))
                    else: return self.send_json({"error": "Choose accept or decline."}, 400)
                return self.send_json({"ok": True})
            return self.send_json({"error": "Endpoint not found."}, 404)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 413)
        except Exception as e:
            return self.send_json({"error": "Server error: " + str(e)}, 500)


from urllib.parse import parse_qs

if __name__ == "__main__":
    init_db()
    print(f"Orbit is running at http://localhost:{PORT} (network: http://<this-computer-ip>:{PORT})")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
