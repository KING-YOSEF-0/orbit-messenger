import { createClient } from "@libsql/client/web";

const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
const MAX_BODY = 12 * 1024 * 1024;
let schemaReady;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
const fail = (message, status = 400) => json({ error: message }, status);
const rows = result => result.rows || [];
const first = result => rows(result)[0] || null;
const lastId = result => Number(result.lastInsertRowid || 0);

async function execute(db, sql, args = []) {
  return db.execute({ sql, args });
}

async function ensureSchema(db) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,bio TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,avatar BLOB,avatar_mime TEXT)`,
    `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS friendships(id INTEGER PRIMARY KEY,sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,status TEXT NOT NULL CHECK(status IN ('pending','accepted')),created_at INTEGER NOT NULL,UNIQUE(sender_id,recipient_id))`,
    `CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL DEFAULT '',audio BLOB,audio_mime TEXT,created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS msg_pair_time ON messages(sender_id,recipient_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS msg_recipient ON messages(recipient_id,created_at)`,
    `CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,invite_code TEXT NOT NULL UNIQUE,owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS server_members(server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at INTEGER NOT NULL,PRIMARY KEY(server_id,user_id))`,
    `CREATE TABLE IF NOT EXISTS server_messages(id INTEGER PRIMARY KEY,server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,text TEXT NOT NULL,created_at INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS server_msg_time ON server_messages(server_id,id)`,
  ];
  for (const sql of statements) await execute(db, sql);
  const columns = rows(await execute(db, "PRAGMA table_info(users)")).map(row => row.name);
  if (!columns.includes("avatar")) await execute(db, "ALTER TABLE users ADD COLUMN avatar BLOB");
  if (!columns.includes("avatar_mime")) await execute(db, "ALTER TABLE users ADD COLUMN avatar_mime TEXT");
}

async function openDatabase(env) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new Error("Database settings are missing. Add TURSO_DATABASE_URL and TURSO_AUTH_TOKEN as Worker secrets.");
  const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  if (!schemaReady) schemaReady = ensureSchema(db).catch(error => { schemaReady = null; throw error; });
  try { await schemaReady; }
  catch (error) { db.close(); throw error; }
  return db;
}

function userJson(row) {
  return { id: Number(row.id), username: row.username, displayName: row.display_name, bio: row.bio || "", hasAvatar: Boolean(row.has_avatar ?? row.avatar) };
}
function bytesToHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex) { return new Uint8Array(hex.match(/.{2}/g).map(pair => parseInt(pair, 16))); }
function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randomToken(size = 32) { const bytes = new Uint8Array(size); crypto.getRandomValues(bytes); return base64Url(bytes); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 260000 }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
function safeEqual(a, b) {
  let diff = a.length ^ b.length;
  const count = Math.max(a.length, b.length);
  for (let i = 0; i < count; i++) diff |= (a.charCodeAt(i % (a.length || 1)) || 0) ^ (b.charCodeAt(i % (b.length || 1)) || 0);
  return diff === 0;
}
function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(value || []);
}
function mediaResponse(bytes, type, cache = "private, no-store") {
  const data = asBytes(bytes);
  return new Response(data, { headers: { "Content-Type": type || "application/octet-stream", "Content-Length": String(data.byteLength), "Cache-Control": cache } });
}
async function readBody(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_BODY) throw new Error("Request is too large (12 MB limit).");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY) throw new Error("Request is too large (12 MB limit).");
  try { return JSON.parse(text || "{}"); }
  catch { throw new Error("Request must contain valid JSON."); }
}
async function authenticate(db, request, allowQuery = false) {
  let token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token && allowQuery) token = new URL(request.url).searchParams.get("token") || "";
  if (!token) return null;
  const row = first(await execute(db, "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?", [token, Math.floor(Date.now() / 1000)]));
  return row ? { token, user: row } : null;
}
function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function match(path, pattern) { return path.match(pattern); }

async function handleApi(request, env) {
  let db;
  try { db = await openDatabase(env); }
  catch (error) { return json({ error: error.message || "Database unavailable." }, 503); }

  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname);
  const method = request.method.toUpperCase();
  try {
    if (method === "GET") {
      if (path === "/api/me") {
        const auth = await authenticate(db, request);
        return json({ user: auth ? userJson(auth.user) : null });
      }
      const avatarMatch = match(path, /^\/api\/avatar\/(\d+)$/);
      if (avatarMatch) {
        const auth = await authenticate(db, request, true);
        if (!auth) return fail("Please sign in.", 401);
        const row = first(await execute(db, "SELECT avatar,avatar_mime FROM users WHERE id=?", [Number(avatarMatch[1])]));
        if (!row?.avatar) return fail("Photo not found.", 404);
        return mediaResponse(row.avatar, row.avatar_mime || "image/jpeg", "private, max-age=300");
      }
      const mediaMatch = match(path, /^\/api\/media\/(\d+)$/);
      if (mediaMatch) {
        const auth = await authenticate(db, request, true);
        if (!auth) return fail("Please sign in.", 401);
        const me = Number(auth.user.id);
        const row = first(await execute(db, "SELECT audio,audio_mime,sender_id,recipient_id FROM messages WHERE id=? AND audio IS NOT NULL", [Number(mediaMatch[1])]));
        if (!row || (me !== Number(row.sender_id) && me !== Number(row.recipient_id))) return fail("Not found.", 404);
        return mediaResponse(row.audio, row.audio_mime || "audio/webm");
      }
      const auth = await authenticate(db, request);
      if (!auth) return fail("Please sign in.", 401);
      const me = Number(auth.user.id);

      if (path === "/api/people") {
        const query = (url.searchParams.get("q") || "").trim().replace(/^@/, "").toLowerCase();
        if (query.length < 2) return json({ people: [] });
        const found = rows(await execute(db, `SELECT u.*,u.avatar IS NOT NULL AS has_avatar FROM users u WHERE u.id<>? AND (lower(u.username) LIKE ? OR lower(u.display_name) LIKE ?) ORDER BY CASE WHEN lower(u.username)=? THEN 0 ELSE 1 END,u.username COLLATE NOCASE LIMIT 30`, [me, `${query}%`, `%${query}%`, query]));
        const relations = rows(await execute(db, "SELECT sender_id,recipient_id,status FROM friendships WHERE sender_id=? OR recipient_id=?", [me, me]));
        const rel = new Map(relations.map(r => [Number(r.recipient_id) === me ? Number(r.sender_id) : Number(r.recipient_id), { status: r.status, incoming: Number(r.recipient_id) === me }]));
        return json({ people: found.map(row => ({ ...userJson(row), relationship: rel.get(Number(row.id))?.status || "none", incoming: rel.get(Number(row.id))?.incoming || false })) });
      }
      if (path === "/api/requests") {
        const found = rows(await execute(db, "SELECT u.*,u.avatar IS NOT NULL AS has_avatar FROM friendships f JOIN users u ON u.id=f.sender_id WHERE f.recipient_id=? AND f.status='pending' ORDER BY f.created_at DESC", [me]));
        return json({ requests: found.map(userJson) });
      }
      if (path === "/api/conversations") {
        const found = rows(await execute(db, `SELECT u.id,u.username,u.display_name,u.bio,u.avatar IS NOT NULL AS has_avatar,m.text,m.audio IS NOT NULL AS has_audio,m.created_at,m.sender_id,m.id AS message_id FROM friendships f JOIN users u ON u.id=CASE WHEN f.sender_id=? THEN f.recipient_id ELSE f.sender_id END LEFT JOIN messages m ON m.id=(SELECT id FROM messages x WHERE (x.sender_id=? AND x.recipient_id=u.id) OR (x.sender_id=u.id AND x.recipient_id=?) ORDER BY x.id DESC LIMIT 1) WHERE f.status='accepted' AND (f.sender_id=? OR f.recipient_id=?) ORDER BY COALESCE(m.id,0) DESC,u.username COLLATE NOCASE`, [me, me, me, me, me]));
        return json({ conversations: found.map(row => ({ ...userJson(row), lastMessage: row.has_audio && !row.text ? "Voice note" : row.text, time: row.created_at })) });
      }
      if (path === "/api/servers") {
        const found = rows(await execute(db, "SELECT s.id,s.name,s.invite_code,s.owner_id,COUNT(DISTINCT sm.user_id) AS member_count FROM server_members mine JOIN servers s ON s.id=mine.server_id JOIN server_members sm ON sm.server_id=s.id WHERE mine.user_id=? GROUP BY s.id ORDER BY s.id DESC", [me]));
        return json({ servers: found.map(row => ({ id:Number(row.id),name:row.name,inviteCode:row.invite_code,ownerId:Number(row.owner_id),memberCount:Number(row.member_count) })) });
      }
      const serverMatch = match(path, /^\/api\/servers\/(\d+)(?:\/messages)?$/);
      if (serverMatch) {
        const serverId = Number(serverMatch[1]);
        if (!first(await execute(db, "SELECT 1 FROM server_members WHERE server_id=? AND user_id=?", [serverId, me]))) return fail("You are not a member of this server.", 403);
        if (path.endsWith("/messages")) {
          const found = rows(await execute(db, "SELECT m.id,m.text,m.created_at,m.user_id,u.username,u.display_name,u.avatar IS NOT NULL AS has_avatar FROM server_messages m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY m.id DESC LIMIT 250", [serverId])).reverse();
          return json({ messages: found.map(row => ({ id:Number(row.id),text:row.text,createdAt:row.created_at,user:{id:Number(row.user_id),username:row.username,displayName:row.display_name,hasAvatar:Boolean(row.has_avatar)} })) });
        }
        const row = first(await execute(db, "SELECT s.id,s.name,s.invite_code,s.owner_id,COUNT(sm.user_id) AS member_count FROM servers s JOIN server_members mine ON mine.server_id=s.id LEFT JOIN server_members sm ON sm.server_id=s.id WHERE s.id=? AND mine.user_id=? GROUP BY s.id", [serverId, me]));
        return row ? json({ server:{id:Number(row.id),name:row.name,inviteCode:row.invite_code,ownerId:Number(row.owner_id),memberCount:Number(row.member_count)} }) : fail("Server not found.",404);
      }
      const messagesMatch = match(path, /^\/api\/messages\/(\d+)$/);
      if (messagesMatch) {
        const other = Number(messagesMatch[1]);
        const allowed = Boolean(first(await execute(db, "SELECT 1 FROM friendships WHERE status='accepted' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))", [me, other, other, me])));
        if (!allowed) return json({ messages: [], allowed: false });
        const found = rows(await execute(db, "SELECT m.id,m.sender_id,m.recipient_id,m.text,m.audio IS NOT NULL AS has_audio,m.created_at,u.username,u.display_name,u.bio,u.avatar IS NOT NULL AS has_avatar FROM messages m JOIN users u ON u.id=m.sender_id WHERE (m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?) ORDER BY m.id DESC LIMIT 200", [me, other, other, me])).reverse();
        return json({ allowed: true, messages: found.map(row => {
          const item = { id:Number(row.id),senderId:Number(row.sender_id),text:row.text,createdAt:row.created_at,sender:{id:Number(row.sender_id),username:row.username,displayName:row.display_name,bio:row.bio,hasAvatar:Boolean(row.has_avatar)} };
          if (row.has_audio) item.audioUrl = `/api/media/${row.id}?token=${encodeURIComponent(auth.token)}`;
          return item;
        }) });
      }
      return fail("Endpoint not found.",404);
    }

    if (method === "POST") {
      let data;
      try { data = await readBody(request); } catch (error) { return fail(error.message, error.message.includes("12 MB") ? 413 : 400); }
      if (path === "/api/register" || path === "/api/login") {
        const username = String(data.username || "").trim();
        const password = String(data.password || "");
        if (!USERNAME_RE.test(username)) return fail("Username must be 3–24 characters: letters, numbers, or underscores.");
        if (password.length < 8) return fail("Password must be at least 8 characters.");
        let userId;
        if (path.endsWith("register")) {
          const display = String(data.displayName || username).trim().slice(0,32) || username;
          const salt = crypto.getRandomValues(new Uint8Array(16));
          const digest = await passwordHash(password, salt);
          try {
            const result = await execute(db, "INSERT INTO users(username,display_name,password_hash,created_at) VALUES(?,?,?,?)", [username,display,`${bytesToHex(salt)}:${digest}`,Math.floor(Date.now()/1000)]);
            userId = lastId(result);
          } catch (error) {
            if (/unique|constraint/i.test(String(error))) return fail("That username is already taken.",409);
            throw error;
          }
        } else {
          const row = first(await execute(db, "SELECT * FROM users WHERE username=? COLLATE NOCASE", [username]));
          if (!row) return fail("Username or password is incorrect.",401);
          const [saltHex, expected] = row.password_hash.split(":",2);
          const actual = await passwordHash(password, hexToBytes(saltHex));
          if (!safeEqual(actual,expected)) return fail("Username or password is incorrect.",401);
          userId = Number(row.id);
        }
        const token = randomToken();
        await execute(db, "INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)", [token,userId,Math.floor(Date.now()/1000)+60*60*24*30]);
        const user = first(await execute(db,"SELECT * FROM users WHERE id=?",[userId]));
        return json({ token, user:userJson(user) });
      }
      const auth = await authenticate(db,request);
      if (!auth) return fail("Please sign in.",401);
      const me = Number(auth.user.id);
      if (path === "/api/logout") {
        await execute(db,"DELETE FROM sessions WHERE token=?",[auth.token]);
        return json({ok:true});
      }
      if (path === "/api/servers") {
        const name = String(data.name||"").trim().slice(0,40);
        if (name.length<2) return fail("Server name must be at least 2 characters.");
        const code = randomToken(7).replace(/[-_]/g,"").slice(0,9).toUpperCase();
        const result = await execute(db,"INSERT INTO servers(name,invite_code,owner_id,created_at) VALUES(?,?,?,?)",[name,code,me,Math.floor(Date.now()/1000)]);
        const id = lastId(result);
        await execute(db,"INSERT INTO server_members(server_id,user_id,joined_at) VALUES(?,?,?)",[id,me,Math.floor(Date.now()/1000)]);
        return json({server:{id,name,inviteCode:code,ownerId:me,memberCount:1}},201);
      }
      if (path === "/api/servers/join") {
        const code = String(data.inviteCode||"").trim().toUpperCase();
        const server = first(await execute(db,"SELECT * FROM servers WHERE invite_code=?",[code]));
        if (!server) return fail("That invite code was not found.",404);
        await execute(db,"INSERT OR IGNORE INTO server_members(server_id,user_id,joined_at) VALUES(?,?,?)",[server.id,me,Math.floor(Date.now()/1000)]);
        const count = first(await execute(db,"SELECT COUNT(*) AS count FROM server_members WHERE server_id=?",[server.id]));
        return json({server:{id:Number(server.id),name:server.name,inviteCode:server.invite_code,ownerId:Number(server.owner_id),memberCount:Number(count.count)}});
      }
      const serverPost = match(path,/^\/api\/servers\/(\d+)\/messages$/);
      if (serverPost) {
        const serverId=Number(serverPost[1]), text=String(data.text||"").trim().slice(0,4000);
        if(!text)return fail("Write a message first.");
        if(!first(await execute(db,"SELECT 1 FROM server_members WHERE server_id=? AND user_id=?",[serverId,me])))return fail("Join this server before sending messages.",403);
        const result=await execute(db,"INSERT INTO server_messages(server_id,user_id,text,created_at) VALUES(?,?,?,?)",[serverId,me,text,Math.floor(Date.now()/1000)]);
        return json({ok:true,id:lastId(result)},201);
      }
      if (path === "/api/requests") {
        const username=String(data.username||"").trim().replace(/^@/,"");
        const target=first(await execute(db,"SELECT id FROM users WHERE username=? COLLATE NOCASE",[username]));
        if(!target)return fail("No account found with that username.",404);
        if(Number(target.id)===me)return fail("You cannot send a request to yourself.");
        const existing=first(await execute(db,"SELECT * FROM friendships WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)",[me,target.id,target.id,me]));
        if(existing){
          if(existing.status==="accepted")return fail("You are already connected.",409);
          if(Number(existing.recipient_id)===me)return fail("This person already sent you a request. Accept it in People → Requests.",409);
          return fail("Request already sent.",409);
        }
        await execute(db,"INSERT INTO friendships(sender_id,recipient_id,status,created_at) VALUES(?,?,'pending',?)",[me,target.id,Math.floor(Date.now()/1000)]);
        return json({ok:true});
      }
      if (path === "/api/messages") {
        const target=Number(data.recipientId||0), text=String(data.text||"").trim().slice(0,4000);
        let audio=null,audioMime=null;
        if(data.audioData){
          if(typeof data.audioData!=="string"||data.audioData.length>10_000_000)return fail("Voice note is too large (7 MB limit).",413);
          try{audio=decodeBase64(data.audioData);}catch{return fail("Invalid audio data.");}
          audioMime=String(data.audioMime||"audio/webm").slice(0,80);
          if(!audioMime.startsWith("audio/"))return fail("Please choose an audio file.");
        }
        if(!text&&!audio)return fail("Write a message or attach a voice note.");
        if(!first(await execute(db,"SELECT 1 FROM friendships WHERE status='accepted' AND ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?))",[me,target,target,me])))return fail("You can message this person after they accept your request.",403);
        const result=await execute(db,"INSERT INTO messages(sender_id,recipient_id,text,audio,audio_mime,created_at) VALUES(?,?,?,?,?,?)",[me,target,text,audio,audioMime,Math.floor(Date.now()/1000)]);
        return json({ok:true,id:lastId(result)});
      }
      return fail("Endpoint not found.",404);
    }

    if (method === "PATCH") {
      const auth=await authenticate(db,request);
      if(!auth)return fail("Please sign in.",401);
      const data=await readBody(request),me=Number(auth.user.id);
      if(path==="/api/profile"){
        const username=String(data.username||"").trim(),display=String(data.displayName||"").trim().slice(0,32),bio=String(data.bio||"").trim().slice(0,160);
        if(!USERNAME_RE.test(username))return fail("Username must be 3–24 characters: letters, numbers, or underscores.");
        if(!display)return fail("Display name cannot be empty.");
        let avatar=null,avatarMime=null;
        if(data.removeAvatar)avatarMime="";
        else if(data.avatarData){
          if(typeof data.avatarData!=="string"||data.avatarData.length>2_800_000)return fail("Profile image must be smaller than 2 MB.",413);
          avatarMime=String(data.avatarMime||"");
          if(!["image/jpeg","image/png","image/webp","image/gif"].includes(avatarMime))return fail("Choose a JPG, PNG, WEBP, or GIF image.");
          try{avatar=decodeBase64(data.avatarData);}catch{return fail("Invalid profile image.");}
          if(avatar.byteLength>2*1024*1024)return fail("Profile image must be smaller than 2 MB.",413);
        }
        try{
          if(data.removeAvatar)await execute(db,"UPDATE users SET username=?,display_name=?,bio=?,avatar=NULL,avatar_mime=NULL WHERE id=?",[username,display,bio,me]);
          else if(avatar)await execute(db,"UPDATE users SET username=?,display_name=?,bio=?,avatar=?,avatar_mime=? WHERE id=?",[username,display,bio,avatar,avatarMime,me]);
          else await execute(db,"UPDATE users SET username=?,display_name=?,bio=? WHERE id=?",[username,display,bio,me]);
        }catch(error){if(/unique|constraint/i.test(String(error)))return fail("That username is already taken.",409);throw error;}
        return json({user:userJson(first(await execute(db,"SELECT * FROM users WHERE id=?",[me])))});
      }
      const requestMatch=match(path,/^\/api\/requests\/(\d+)$/);
      if(requestMatch){
        const sender=Number(requestMatch[1]), action=data.action;
        const req=first(await execute(db,"SELECT * FROM friendships WHERE sender_id=? AND recipient_id=? AND status='pending'",[sender,me]));
        if(!req)return fail("That request is no longer pending.",404);
        if(action==="accept")await execute(db,"UPDATE friendships SET status='accepted' WHERE id=?",[req.id]);
        else if(action==="decline")await execute(db,"DELETE FROM friendships WHERE id=?",[req.id]);
        else return fail("Choose accept or decline.");
        return json({ok:true});
      }
      return fail("Endpoint not found.",404);
    }
    return fail("Method not allowed.",405);
  } catch (error) {
    if (error instanceof SyntaxError) return fail("Request must contain valid JSON.");
    return json({ error: `Server error: ${error.message || "Unknown error."}` }, 500);
  } finally {
    db.close();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });
    return handleApi(request, env);
  },
};
