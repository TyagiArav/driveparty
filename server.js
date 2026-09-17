import express from 'express';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Optional. With a key, Drive files stream through the official Drive API,
// which is more reliable for large files than the public download endpoint.
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';

const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/party/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'party.html')));

// ---------------------------------------------------------------------------
// Google Drive streaming proxy
// ---------------------------------------------------------------------------

const DRIVE_ID = /^[\w-]{10,}$/;

class DriveError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function explainHtmlResponse(html, finalUrl) {
  if (finalUrl.includes('accounts.google.com') || /ServiceLogin|Sign in/i.test(html)) {
    return new DriveError('This file is not public. In Google Drive, set sharing to "Anyone with the link".', 403);
  }
  if (/quota|Too many users/i.test(html)) {
    return new DriveError('Google Drive download quota exceeded for this file. Try again later or make a copy of the file.', 429);
  }
  if (/not found|does not exist|404/i.test(html)) {
    return new DriveError('File not found. Check the link.', 404);
  }
  return new DriveError('Google Drive refused to stream this file.', 502);
}

/** Fetch a Drive file's bytes, following the "can't scan for viruses" interstitial if needed. */
async function fetchDriveFile(id, range, signal) {
  const headers = range ? { Range: range } : {};

  if (GOOGLE_API_KEY) {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true&key=${GOOGLE_API_KEY}`,
      { headers, signal },
    );
    if (res.ok) return res;
    await res.body?.cancel();
    // Fall through to the public endpoint.
  }

  let url = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers, signal, redirect: 'follow' });
    const type = res.headers.get('content-type') || '';
    if (!type.includes('text/html')) {
      if (!res.ok) {
        await res.body?.cancel();
        throw new DriveError(`Google Drive responded with ${res.status}.`, res.status === 404 ? 404 : 502);
      }
      return res;
    }
    const html = await res.text();
    if (new URL(res.url).hostname !== 'drive.usercontent.google.com') throw explainHtmlResponse(html, res.url);
    const form = html.match(/<form[^>]*id="download-form"[^>]*action="([^"]+)"/) || html.match(/<form[^>]*action="([^"]+)"/);
    if (!form) throw explainHtmlResponse(html, res.url);
    const params = new URLSearchParams();
    for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) {
      params.set(m[1], m[2]);
    }
    url = `${form[1].replace(/&amp;/g, '&')}?${params}`;
  }
  throw new DriveError('Could not get past Google Drive\'s download confirmation page.');
}

function filenameFromDisposition(value) {
  if (!value) return '';
  const star = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) return decodeURIComponent(star[1]);
  const plain = value.match(/filename="?([^";]+)"?/i);
  // Header bytes arrive as latin1; Drive sends raw UTF-8.
  return plain ? Buffer.from(plain[1], 'latin1').toString('utf8') : '';
}

const NON_VIDEO_EXT = /^(pdf|docx?|xlsx?|pptx?|txt|csv|jpe?g|png|gif|webp|heic|zip|rar|7z|mp3|wav|m4a|flac|aac)$/;
const MIME_BY_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', ogv: 'video/ogg' };

app.get('/api/drive/:id/info', async (req, res) => {
  const { id } = req.params;
  if (!DRIVE_ID.test(id)) return res.status(400).json({ ok: false, error: 'Invalid Google Drive file ID.' });
  try {
    const upstream = await fetchDriveFile(id, 'bytes=0-0', AbortSignal.timeout(15000));
    const name = filenameFromDisposition(upstream.headers.get('content-disposition'));
    const ext = name.split('.').pop().toLowerCase();
    if (!(upstream.headers.get('content-type') || '').match(/video|octet|binary|matroska/) || NON_VIDEO_EXT.test(ext)) {
      await upstream.body?.cancel();
      return res.status(415).json({ ok: false, error: 'That Drive file doesn\'t look like a video.' });
    }
    await upstream.body?.cancel();
    const total = upstream.headers.get('content-range')?.split('/')[1];
    res.json({
      ok: true,
      name: name || 'Google Drive video',
      size: total && total !== '*' ? Number(total) : null,
      mimeType: upstream.headers.get('content-type'),
    });
  } catch (err) {
    if (!(err instanceof DriveError)) console.error('Drive info failed:', err);
    res.status(err.status || 502).json({ ok: false, error: err instanceof DriveError ? err.message : 'Could not reach Google Drive.' });
  }
});

app.get('/api/drive/:id/stream', async (req, res) => {
  const { id } = req.params;
  if (!DRIVE_ID.test(id)) return res.status(400).json({ error: 'Invalid Google Drive file ID.' });

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  try {
    const upstream = await fetchDriveFile(id, req.headers.range, controller.signal);
    res.status(upstream.status);
    for (const header of ['content-length', 'content-range', 'last-modified', 'etag']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    let type = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!type.startsWith('video/')) {
      const ext = filenameFromDisposition(upstream.headers.get('content-disposition')).split('.').pop()?.toLowerCase();
      type = MIME_BY_EXT[ext] || type;
    }
    res.setHeader('content-type', type);
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'private, max-age=3600');
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (err) {
    if (controller.signal.aborted || res.headersSent) return;
    res.status(err.status || 502).json({ error: err instanceof DriveError ? err.message : 'Could not reach Google Drive.' });
  }
});

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
  if (!GOOGLE_API_KEY) console.log('Tip: set GOOGLE_API_KEY for more reliable streaming of large Drive files.');
});
