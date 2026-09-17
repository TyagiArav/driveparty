// Google sign-in, the Drive file picker, and the streaming service worker.

let config = null;
let configPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else existing.addEventListener('load', resolve, { once: true });
      return;
    }
    const script = Object.assign(document.createElement('script'), { src, async: true });
    script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Couldn't load ${new URL(src).hostname}. Check your connection or ad blocker.`)), { once: true });
    document.head.append(script);
  });
}

/** Load config and Google's scripts up front, so sign-in can open its popup straight from a click. */
export function initGoogle() {
  configPromise ??= fetch('/api/config')
    .then((res) => res.json())
    .then(async (data) => {
      config = data;
      if (data.configured) await loadScript('https://accounts.google.com/gsi/client');
      return data;
    });
  return configPromise;
}

export async function getMe() {
  const res = await fetch('/api/me', { cache: 'no-store' });
  return res.json();
}

export class NeedsConsentError extends Error {
  constructor() {
    super('One more step: click again to finish signing in.');
  }
}

/**
 * Start Google sign-in. Must be called directly from a click handler (it opens a popup).
 * Pass { consent: true } after a NeedsConsentError.
 */
export function signIn({ consent = false } = {}) {
  if (!config?.configured || !window.google?.accounts?.oauth2) {
    return Promise.reject(new Error(config && !config.configured
      ? 'Google sign-in isn\'t set up on this server yet (see README).'
      : 'Still loading Google sign-in. Try again in a second.'));
  }
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initCodeClient({
      client_id: config.clientId,
      scope: config.scope,
      ux_mode: 'popup',
      ...(consent ? { prompt: 'consent' } : {}),
      callback: async (response) => {
        if (response.error) return reject(new Error('Google sign-in was cancelled.'));
        try {
          const res = await fetch('/auth/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-requested-with': 'XmlHttpRequest' },
            body: JSON.stringify({ code: response.code }),
          });
          const data = await res.json();
          if (data.needConsent && !data.error) return reject(new NeedsConsentError());
          if (!res.ok) return reject(new Error(data.error || 'Google sign-in failed.'));
          await resetMediaWorker();
          resolve(data);
        } catch {
          reject(new Error('Google sign-in failed. Try again.'));
        }
      },
      error_callback: (err) => reject(new Error(err?.type === 'popup_closed' ? 'Google sign-in was cancelled.' : 'Couldn\'t open the Google sign-in popup. Allow popups for this site.')),
    });
    client.requestCode();
  });
}

export async function signOut() {
  await fetch('/auth/logout', { method: 'POST' });
  await resetMediaWorker();
}

async function getAccessToken() {
  const res = await fetch('/api/token', { cache: 'no-store' });
  if (!res.ok) throw Object.assign(new Error('Not signed in.'), { status: 401 });
  return (await res.json()).accessToken;
}

/**
 * Check whether the signed-in user can stream a Drive file.
 * Resolves to { ok, name } or { ok: false, reason: 'signed-out' | 'no-access' | 'not-video' | 'error' }.
 */
export async function checkDriveAccess(id) {
  let token;
  try {
    token = await getAccessToken();
  } catch {
    return { ok: false, reason: 'signed-out' };
  }
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=name,mimeType,size&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res) return { ok: false, reason: 'error' };
  if (res.status === 401) return { ok: false, reason: 'signed-out' };
  // With the "files you choose" permission, Drive answers 404 until the user opens the file in the picker.
  if (res.status === 403 || res.status === 404) return { ok: false, reason: 'no-access' };
  if (!res.ok) return { ok: false, reason: 'error' };
  const file = await res.json();
  const isHls = isHlsFile(file);
  if (!isHls && !file.mimeType?.startsWith('video/') && file.mimeType !== 'application/octet-stream') {
    return { ok: false, reason: 'not-video', name: file.name };
  }
  return { ok: true, name: file.name, mimeType: file.mimeType, size: Number(file.size), isHls };
}

export function isHlsFile(file) {
  return /\.m3u8$/i.test(file.name || '') || /mpegurl/i.test(file.mimeType || '');
}

/** Every relative file a playlist points at: segments, variant playlists, keys, init segments. */
function playlistUris(text) {
  const uris = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      for (const match of line.matchAll(/URI="([^"]+)"/g)) uris.push(match[1]);
    } else {
      uris.push(line);
    }
  }
  return uris.filter((uri) => !/^[a-z][a-z0-9+.-]*:/i.test(uri)); // absolute URLs load on their own
}

function baseName(uri) {
  const last = uri.split(/[?#]/)[0].split('/').pop() || '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Check that the signed-in user can open every file an HLS stream in Drive needs.
 * Resolves to { ok: true } or { ok: false, reason: 'hls-missing', missing, folderId } / { ok: false, reason: 'error' }.
 */
export async function checkDriveHls(playlistId) {
  const base = `/media/drive-hls/${encodeURIComponent(playlistId)}/`;
  const indexRes = await fetch(`${base}?index`, { cache: 'no-store' }).catch(() => null);
  if (!indexRes?.ok) return { ok: false, reason: indexRes?.status === 401 ? 'signed-out' : 'error' };
  const index = await indexRes.json();

  const available = new Set(index.files);
  const missing = new Set();
  const queue = [index.playlist];
  const seen = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    if (!available.has(name)) {
      missing.add(name);
      continue;
    }
    const text = await fetch(base + encodeURIComponent(name)).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    for (const uri of playlistUris(text)) {
      const child = baseName(uri);
      if (/\.m3u8$/i.test(child)) queue.push(child);
      else if (!available.has(child)) missing.add(child);
    }
  }
  return missing.size ? { ok: false, reason: 'hls-missing', missing: [...missing], folderId: index.folderId } : { ok: true };
}

/**
 * Open Google's Drive picker. With fileId, it shows only that file, which is how
 * a guest grants DriveParty access to a video someone shared with them.
 * Resolves to { id, name } or null if cancelled.
 */
export async function pickDriveVideo({ fileId } = {}) {
  await initGoogle();
  const [token] = await Promise.all([getAccessToken(), loadPickerApi()]);
  const { picker } = window.google;

  const views = [];
  if (fileId) {
    views.push(new picker.DocsView(picker.ViewId.DOCS).setFileIds(fileId).setMode(picker.DocsViewMode.GRID));
  } else {
    views.push(
      new picker.DocsView(picker.ViewId.DOCS_VIDEOS).setOwnedByMe(true).setLabel('My Drive').setMode(picker.DocsViewMode.GRID),
      new picker.DocsView(picker.ViewId.DOCS_VIDEOS).setOwnedByMe(false).setLabel('Shared with me').setMode(picker.DocsViewMode.GRID),
      new picker.DocsView(picker.ViewId.DOCS_VIDEOS).setEnableDrives(true).setLabel('Shared drives').setMode(picker.DocsViewMode.GRID),
      // HLS playlists (.m3u8) aren't "videos" to Drive, so they only show up among all files.
      new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true).setLabel('All files (for .m3u8)').setMode(picker.DocsViewMode.LIST),
    );
  }

  const docs = await openPicker({
    token,
    views,
    title: fileId ? 'Select the party video to open it' : 'Choose a video or an .m3u8 playlist',
  });
  if (!docs) return null;
  const doc = docs[0];
  return { id: doc.id, name: doc.name, mimeType: doc.mimeType, isHls: isHlsFile(doc) };
}

/**
 * Open the picker inside an HLS stream's folder so the user can select all of its files at once.
 * Resolves to the number of files selected, or null if cancelled.
 */
export async function pickHlsFiles({ folderId }) {
  await initGoogle();
  const [token] = await Promise.all([getAccessToken(), loadPickerApi()]);
  const { picker } = window.google;
  const view = new picker.DocsView(picker.ViewId.DOCS).setParent(folderId).setMode(picker.DocsViewMode.LIST);
  const docs = await openPicker({
    token,
    views: [view],
    multiselect: true,
    title: 'Select every file in this folder (click the first, Shift-click the last)',
  });
  return docs ? docs.length : null;
}

function loadPickerApi() {
  return loadScript('https://apis.google.com/js/api.js').then(() => new Promise((resolve) => window.gapi.load('picker', resolve)));
}

function openPicker({ token, views, title, multiselect = false }) {
  const { picker } = window.google;
  return new Promise((resolve) => {
    const builder = new picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setTitle(title)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) resolve(data.docs);
        else if (data.action === picker.Action.CANCEL) resolve(null);
      });
    if (multiselect) builder.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    for (const view of views) builder.addView(view);
    builder.build().setVisible(true);
  });
}

/** Register the worker that streams Drive files, and wait until it controls this page. */
export async function ensureMediaWorker() {
  if (!('serviceWorker' in navigator)) {
    throw new Error(window.isSecureContext
      ? 'This browser can\'t stream Drive videos. Try Chrome, Edge or Firefox (not in private mode).'
      : 'Drive streaming needs a secure (https) address. Open the site over https or at localhost.');
  }
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The video streamer didn\'t start. Reload the page.')), 4000);
    navigator.serviceWorker.addEventListener('controllerchange', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function resetMediaWorker() {
  const registration = await navigator.serviceWorker?.getRegistration();
  registration?.active?.postMessage({ type: 'reset' });
}

/**
 * Make sure the signed-in user can stream a Drive file, opening the picker
 * (filtered to that file) when they haven't given DriveParty access to it yet.
 */
export async function openDriveFile(id) {
  let access = await checkDriveAccess(id);
  if (access.reason !== 'no-access') return access;
  const picked = await pickDriveVideo({ fileId: id });
  if (!picked) return { ok: false, reason: 'cancelled' };
  access = await checkDriveAccess(id);
  return access;
}

export function accessMessage(reason, email) {
  switch (reason) {
    case 'signed-out': return 'Sign in with Google to watch.';
    case 'no-access': return `This video isn't shared with ${email || 'your Google account'}. Ask whoever owns it to share it with you in Google Drive.`;
    case 'not-video': return 'That Drive file isn\'t a video.';
    case 'cancelled': return 'You need to select the video in the Google picker so DriveParty can open it.';
    case 'hls-missing': return 'Some of this stream\'s files haven\'t been opened with DriveParty yet.';
    default: return 'Couldn\'t reach Google Drive. Try again.';
  }
}
