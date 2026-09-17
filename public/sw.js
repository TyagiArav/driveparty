// Streams Drive videos straight from Google with the viewer's own access token.
//
// A <video> element can't send an Authorization header, so its requests go to
// /media/drive/<id> and this worker re-issues them to the Drive API. Google
// doesn't expose Content-Range to browsers, so the worker rebuilds the range
// headers from the file size.

const MEDIA_PATH = /^\/media\/drive\/([\w-]{10,})$/;
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
const MIME_FIXES = { 'video/quicktime': 'video/mp4', 'video/x-m4v': 'video/mp4' };

let token = null; // { value, expiresAt }
let pendingToken = null;
const metadata = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'reset') {
    token = null;
    metadata.clear();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const match = url.pathname.match(MEDIA_PATH);
  if (match) event.respondWith(streamDriveFile(match[1], event.request));
});

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

function getToken(force) {
  if (!force && token && token.expiresAt - 60_000 > Date.now()) return Promise.resolve(token.value);
  pendingToken ??= fetch('/api/token', { credentials: 'same-origin', cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new HttpError(401);
      const data = await res.json();
      token = { value: data.accessToken, expiresAt: Date.now() + data.expiresIn * 1000 };
      return token.value;
    })
    .finally(() => { pendingToken = null; });
  return pendingToken;
}

async function driveFetch(url, headers = {}) {
  let res;
  for (const force of [false, true]) {
    res = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${await getToken(force)}` } });
    if (res.status !== 401) return res;
  }
  return res;
}

async function getMetadata(id) {
  if (!metadata.has(id)) {
    const request = driveFetch(`${DRIVE_API}/${id}?fields=size,mimeType&supportsAllDrives=true`).then(async (res) => {
      if (!res.ok) throw new HttpError(res.status);
      return res.json();
    });
    metadata.set(id, request);
    request.catch(() => metadata.delete(id));
  }
  return metadata.get(id);
}

function parseRange(header, size) {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start;
  let end;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

async function streamDriveFile(id, request) {
  try {
    const info = await getMetadata(id);
    const size = Number(info.size);
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }

    const upstream = await driveFetch(
      `${DRIVE_API}/${id}?alt=media&supportsAllDrives=true`,
      range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    );
    if (!upstream.ok) {
      upstream.body?.cancel();
      return new Response(null, { status: upstream.status });
    }

    const headers = {
      'Accept-Ranges': 'bytes',
      'Content-Type': MIME_FIXES[info.mimeType] || info.mimeType || 'video/mp4',
    };
    if (range && upstream.status === 206) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
      headers['Content-Length'] = String(range.end - range.start + 1);
      return new Response(upstream.body, { status: 206, headers });
    }
    headers['Content-Length'] = String(size);
    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    return new Response(null, { status: err instanceof HttpError ? err.status : 502 });
  }
}
