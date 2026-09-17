import express from 'express';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

try {
  process.loadEnvFile();
} catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Google Cloud credentials. See README → "Google setup".
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || ''; // browser key, used by the Drive file picker
const GOOGLE_PROJECT_NUMBER = process.env.GOOGLE_PROJECT_NUMBER || '';
const GOOGLE_CONFIGURED = Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_API_KEY && GOOGLE_PROJECT_NUMBER);

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn('SESSION_SECRET is not set; everyone will be signed out when the server restarts.');

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const SESSION_COOKIE = 'dp_session';
const SESSION_MAX_AGE = 180 * 24 * 60 * 60 * 1000;

const app = express();
app.set('trust proxy', 1);
const server = createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/party/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'party.html')));

// ---------------------------------------------------------------------------
// Google sign-in
//
// Video never passes through this server. Each viewer signs in with Google and
// their browser streams the Drive file directly (see public/sw.js). The server
// only keeps the viewer's refresh token, encrypted inside their own cookie, and
// trades it for short-lived access tokens.
// ---------------------------------------------------------------------------

const DRIVE_ID = /^[\w-]{10,}$/;
const sessionKey = crypto.createHash('sha256').update(SESSION_SECRET).digest();

function seal(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function unseal(value) {
  try {
    const raw = Buffer.from(value, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function getSession(req) {
  const cookie = readCookie(req, SESSION_COOKIE);
  return cookie ? { cookie, data: unseal(cookie) } : { cookie: '', data: null };
}

function clearSession(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

async function googleToken(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, ...params }),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

app.get('/api/config', (req, res) => {
  res.json({
    configured: GOOGLE_CONFIGURED,
    clientId: GOOGLE_CLIENT_ID,
    apiKey: GOOGLE_API_KEY,
    appId: GOOGLE_PROJECT_NUMBER,
    scope: `openid email profile ${DRIVE_SCOPE}`,
  });
});

app.post('/auth/google', async (req, res) => {
  // The popup code flow requires this header, which cross-site forms can't send.
  if (req.get('x-requested-with') !== 'XmlHttpRequest') return res.status(400).json({ error: 'Bad request.' });
  if (!GOOGLE_CONFIGURED) return res.status(503).json({ error: 'Google sign-in isn\'t set up on this server.' });
  const code = String(req.body?.code || '');
  if (!code) return res.status(400).json({ error: 'Missing sign-in code.' });

  const { ok, data } = await googleToken({ code, grant_type: 'authorization_code', redirect_uri: 'postmessage' });
  if (!ok) return res.status(400).json({ error: 'Google sign-in failed. Try again.' });
  if (!String(data.scope || '').includes(DRIVE_SCOPE)) {
    return res.status(400).json({ error: 'DriveParty needs permission to open the Drive files you choose. Sign in again and leave that box checked.', needConsent: true });
  }
  // Google only issues a refresh token on first consent; ask again if this device didn't get one.
  if (!data.refresh_token) return res.status(409).json({ needConsent: true });

  const profile = JSON.parse(Buffer.from(String(data.id_token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  const session = { rt: data.refresh_token, email: profile.email || '', name: profile.given_name || profile.name || '', picture: profile.picture || '' };
  const cookie = seal(session);
  tokenCache.set(cookie, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  res.cookie(SESSION_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MAX_AGE, path: '/' });
  res.json({ signedIn: true, email: session.email, name: session.name, picture: session.picture });
});

app.post('/auth/logout', (req, res) => {
  const { cookie } = getSession(req);
  tokenCache.delete(cookie);
  clearSession(res);
  res.json({ signedIn: false });
});

app.get('/api/me', (req, res) => {
  const { data } = getSession(req);
  if (!data) return res.json({ signedIn: false });
  res.json({ signedIn: true, email: data.email, name: data.name, picture: data.picture });
});

const tokenCache = new Map(); // session cookie -> { accessToken, expiresAt }

app.get('/api/token', async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  const { cookie, data } = getSession(req);
  if (!data) {
    if (cookie) clearSession(res);
    return res.status(401).json({ error: 'Not signed in.' });
  }

  const cached = tokenCache.get(cookie);
  if (cached && cached.expiresAt - 120_000 > Date.now()) {
    return res.json({ accessToken: cached.accessToken, expiresIn: Math.floor((cached.expiresAt - Date.now()) / 1000) });
  }

  const result = await googleToken({ refresh_token: data.rt, grant_type: 'refresh_token' });
  if (!result.ok) {
    tokenCache.delete(cookie);
    if (result.data.error === 'invalid_grant') {
      clearSession(res);
      return res.status(401).json({ error: 'Your Google sign-in expired. Sign in again.' });
    }
    return res.status(502).json({ error: 'Couldn\'t reach Google.' });
  }
  const entry = { accessToken: result.data.access_token, expiresAt: Date.now() + result.data.expires_in * 1000 };
  tokenCache.set(cookie, entry);
  res.json({ accessToken: entry.accessToken, expiresIn: result.data.expires_in });
});

setInterval(() => {
  for (const [key, entry] of tokenCache) if (entry.expiresAt < Date.now()) tokenCache.delete(key);
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const rooms = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const COLORS = ['#ff7a59', '#4cc9f0', '#f7b801', '#80ed99', '#c77dff', '#ff5d8f', '#56cfe1', '#ffd166'];
const EMPTY_ROOM_TTL = 60 * 60 * 1000;
const MAX_MESSAGES = 200;

function newCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validateSource(input) {
  if (!input || typeof input !== 'object') return null;
  const title = cleanText(input.title, 200);
  if (input.type === 'drive' && DRIVE_ID.test(input.id)) return { type: 'drive', id: input.id, title };
  if (input.type === 'url') {
    try {
      const url = new URL(input.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') return { type: 'url', url: url.href, title };
    } catch {}
  }
  return null;
}

function currentTime(playback, now = Date.now()) {
  return playback.paused ? playback.time : playback.time + ((now - playback.at) / 1000) * playback.rate;
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function snapshot(room) {
  return {
    code: room.code,
    source: room.source,
    playback: room.playback,
    users: [...room.users.values()],
    serverNow: Date.now(),
  };
}

function pushMessage(room, message) {
  const full = { id: crypto.randomUUID(), at: Date.now(), ...message };
  room.messages.push(full);
  if (room.messages.length > MAX_MESSAGES) room.messages.shift();
  io.to(room.code).emit('chat', full);
  return full;
}

app.post('/api/parties', (req, res) => {
  const source = validateSource(req.body?.source);
  if (!source) return res.status(400).json({ error: 'Invalid video source.' });
  const code = newCode();
  rooms.set(code, {
    code,
    source,
    playback: { paused: true, time: 0, at: Date.now(), rate: 1 },
    users: new Map(),
    messages: [],
    emptySince: Date.now(),
    seekNoticeTimer: null,
  });
  res.json({ code });
});

app.get('/api/parties/:code', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ exists: false });
  res.json({ exists: true, title: room.source.title, users: room.users.size });
});

io.on('connection', (socket) => {
  let room = null;
  let user = null;

  socket.on('clock', (_, reply) => typeof reply === 'function' && reply(Date.now()));

  socket.on('join', (payload, reply) => {
    if (typeof reply !== 'function') return;
    const target = rooms.get(cleanText(payload?.code, 12).toUpperCase());
    if (!target) return reply({ error: 'That party doesn\'t exist (or it ended). Ask for a new link.' });
    if (room) return reply({ error: 'Already in a party.' });

    const taken = new Set([...target.users.values()].map((u) => u.color));
    room = target;
    user = {
      id: socket.id,
      name: cleanText(payload?.name, 24) || 'Guest',
      color: COLORS.find((c) => !taken.has(c)) || COLORS[target.users.size % COLORS.length],
    };
    room.users.set(socket.id, user);
    room.emptySince = null;
    socket.join(room.code);

    reply({ ok: true, you: user, room: snapshot(room), messages: room.messages });
    socket.to(room.code).emit('users', [...room.users.values()]);
    pushMessage(room, { type: 'system', text: `${user.name} joined the party` });
  });

  socket.on('control', (payload) => {
    if (!room) return;
    const action = payload?.action;
    const time = Number(payload?.time);
    if (!['play', 'pause', 'seek'].includes(action) || !Number.isFinite(time) || time < 0) return;

    const now = Date.now();
    const paused = action === 'play' ? false : action === 'pause' ? true : room.playback.paused;
    room.playback = { paused, time, at: now, rate: 1 };
    io.to(room.code).emit('playback', { playback: room.playback, by: user.id, action, serverNow: now });

    if (action === 'seek') {
      // Scrubbing fires many seeks; only announce where it settled.
      clearTimeout(room.seekNoticeTimer);
      const name = user.name;
      const r = room;
      room.seekNoticeTimer = setTimeout(() => {
        pushMessage(r, { type: 'system', text: `${name} jumped to ${formatTime(currentTime(r.playback))}` });
      }, 900);
    } else {
      pushMessage(room, { type: 'system', text: `${user.name} ${action === 'play' ? 'played' : 'paused'} at ${formatTime(time)}` });
    }
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const clean = String(text ?? '').trim().slice(0, 1000);
    if (!clean) return;
    pushMessage(room, { type: 'user', userId: user.id, name: user.name, color: user.color, text: clean });
  });

  socket.on('source', (input, reply) => {
    if (!room) return;
    const source = validateSource(input);
    if (!source) return typeof reply === 'function' && reply({ error: 'Invalid video source.' });
    room.source = source;
    room.playback = { paused: true, time: 0, at: Date.now(), rate: 1 };
    io.to(room.code).emit('source', { source, playback: room.playback, serverNow: Date.now() });
    pushMessage(room, { type: 'system', text: `${user.name} changed the video to "${source.title || 'a new video'}"` });
    if (typeof reply === 'function') reply({ ok: true });
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.users.delete(socket.id);
    io.to(room.code).emit('users', [...room.users.values()]);
    pushMessage(room, { type: 'system', text: `${user.name} left` });
    if (room.users.size === 0) {
      room.emptySince = Date.now();
      // Nobody is watching; freeze the clock where it is.
      if (!room.playback.paused) room.playback = { paused: true, time: currentTime(room.playback), at: Date.now(), rate: 1 };
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.users.size === 0 && room.emptySince && now - room.emptySince > EMPTY_ROOM_TTL) rooms.delete(code);
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`DriveParty running at http://localhost:${PORT}`);
  if (!GOOGLE_CONFIGURED) console.log('Google sign-in is not configured. Copy .env.example to .env and fill it in (see README).');
});
