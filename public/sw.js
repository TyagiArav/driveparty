// Streams Drive videos straight from Google with the viewer's own access token.
//
// A <video> element (or hls.js) can't send an Authorization header, so its
// requests go to same-origin /media/... paths and this worker re-issues them to
// the Drive API. Google doesn't expose Content-Range to browsers, so the worker
// rebuilds the range headers from the file size.
//
//   /media/drive/<fileId>                  a single video file
//   /media/drive-hls/<playlistId>/         the playlist itself
//   /media/drive-hls/<playlistId>/<name>   a file of an HLS stream stored in a Drive folder;
//                                          <name> is resolved by file name in the
//                                          playlist's folder
//   /media/drive-hls/<playlistId>/?index   JSON list of stream files this user can open

const FILE_PATH = /^\/media\/drive\/([\w-]{10,})$/;
const HLS_PATH = /^\/media\/drive-hls\/([\w-]{10,})\/(.*)$/;
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';

const TYPE_BY_EXT = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  vtt: 'text/vtt',
  webvtt: 'text/vtt',
};
const MIME_FIXES = { 'video/quicktime': 'video/mp4', 'video/x-m4v': 'video/mp4' };

let token = null; // { value, expiresAt }
let pendingToken = null;
const fileMetadata = new Map(); // fileId -> Promise<{ id, size, mimeType }>
const hlsIndexes = new Map(); // playlistId -> { builtAt, promise: Promise<index> }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  if (event.data?.type === 'reset') {
    token = null;
    fileMetadata.clear();
    hlsIndexes.clear();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  const file = url.pathname.match(FILE_PATH);
  if (file) return event.respondWith(serve(() => streamFile(file[1], event.request)));

  const hls = url.pathname.match(HLS_PATH);
  if (hls) {
    const [, playlistId, rest] = hls;
    if (!rest && url.searchParams.has('index')) return event.respondWith(serve(() => describeHlsIndex(playlistId)));
    if (!rest) return event.respondWith(serve(() => streamHlsPlaylist(playlistId, event.request)));
    return event.respondWith(serve(() => streamHlsFile(playlistId, rest, event.request)));
  }
});

class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function serve(handler) {
  try {
    return await handler();
  } catch (err) {
    return new Response(null, { status: err instanceof HttpError ? err.status : 502 });
  }
}

// ---------------------------------------------------------------------------
// Google auth + Drive API
// ---------------------------------------------------------------------------

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

async function driveJson(url) {
  const res = await driveFetch(url);
  if (!res.ok) throw new HttpError(res.status);
  return res.json();
}

function getFileMetadata(id) {
  if (!fileMetadata.has(id)) {
    const request = driveJson(`${DRIVE_API}/${id}?fields=id,size,mimeType&supportsAllDrives=true`);
    fileMetadata.set(id, request);
    request.catch(() => fileMetadata.delete(id));
  }
  return fileMetadata.get(id);
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

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

async function streamDriveBytes(file, request, contentType) {
  const size = Number(file.size);
  const range = parseRange(request.headers.get('range'), size);
  if (range === 'invalid') {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }

  const upstream = await driveFetch(
    `${DRIVE_API}/${file.id}?alt=media&supportsAllDrives=true`,
    range ? { Range: `bytes=${range.start}-${range.end}` } : {},
  );
  if (!upstream.ok) {
    upstream.body?.cancel();
    return new Response(null, { status: upstream.status });
  }

  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': contentType };
  if (range && upstream.status === 206) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    return new Response(upstream.body, { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(upstream.body, { status: 200, headers });
}

async function streamFile(id, request) {
  const file = await getFileMetadata(id);
  return streamDriveBytes(file, request, MIME_FIXES[file.mimeType] || file.mimeType || 'video/mp4');
}

// ---------------------------------------------------------------------------
// HLS streams stored in Drive
// ---------------------------------------------------------------------------

/** The file name a playlist URI refers to ("720p/seg001.ts?x=1" -> "seg001.ts"). */
function baseName(uri) {
  const last = uri.split(/[?#]/)[0].split('/').pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

function escapeQuery(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function buildHlsIndex(playlistId) {
  const playlist = await driveJson(`${DRIVE_API}/${playlistId}?fields=id,name,size,mimeType,parents&supportsAllDrives=true`);
  const files = new Map([[playlist.name, playlist]]);
  const folderId = playlist.parents?.[0] || null;
  if (folderId) {
    // With the "files you choose" permission, this lists only files the user has opened with DriveParty.
    const q = encodeURIComponent(`'${escapeQuery(folderId)}' in parents and trashed = false`);
    let pageToken = '';
    do {
      const page = await driveJson(
        `${DRIVE_API}?q=${q}&fields=nextPageToken,files(id,name,size,mimeType)&pageSize=1000` +
        `&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      );
      for (const file of page.files || []) if (!files.has(file.name)) files.set(file.name, file);
      pageToken = page.nextPageToken || '';
    } while (pageToken);
  }
  return { playlist, folderId, files };
}

function getHlsIndex(playlistId, { refresh = false, force = false } = {}) {
  const cached = hlsIndexes.get(playlistId);
  // On a miss, refresh at most every few seconds; the user may have granted access to more files.
  if (cached && !force && !(refresh && Date.now() - cached.builtAt > 3000)) return cached.promise;
  const promise = buildHlsIndex(playlistId);
  hlsIndexes.set(playlistId, { builtAt: Date.now(), promise });
  promise.catch(() => hlsIndexes.delete(playlistId));
  return promise;
}

async function findHlsFile(playlistId, name) {
  let index = await getHlsIndex(playlistId);
  let file = index.files.get(name);
  if (!file) {
    index = await getHlsIndex(playlistId, { refresh: true });
    file = index.files.get(name);
  }
  if (!file && !index.folderId) {
    // The folder itself isn't visible to this user; fall back to finding the file by name.
    const q = encodeURIComponent(`name = '${escapeQuery(name)}' and trashed = false`);
    const page = await driveJson(`${DRIVE_API}?q=${q}&fields=files(id,name,size,mimeType)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`);
    file = page.files?.[0];
    if (file) index.files.set(name, file);
  }
  if (!file) throw new HttpError(404);
  return file;
}

async function streamHlsFile(playlistId, path, request) {
  const name = baseName(path);
  const file = await findHlsFile(playlistId, name);
  const ext = name.split('.').pop().toLowerCase();
  return streamDriveBytes(file, request, TYPE_BY_EXT[ext] || file.mimeType || 'application/octet-stream');
}

async function streamHlsPlaylist(playlistId, request) {
  const { playlist } = await getHlsIndex(playlistId);
  return streamDriveBytes(playlist, request, TYPE_BY_EXT.m3u8);
}

async function describeHlsIndex(playlistId) {
  const index = await getHlsIndex(playlistId, { force: true });
  return Response.json({
    playlist: index.playlist.name,
    folderId: index.folderId,
    files: [...index.files.keys()],
  }, { headers: { 'Cache-Control': 'no-store' } });
}
