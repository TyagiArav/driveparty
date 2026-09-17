// Shared helpers for the home and party pages.

export function parseSource(input) {
  const value = String(input || '').trim();
  if (!value) return null;
  if (/drive\.google\.com\/drive\/(u\/\d+\/)?folders\//.test(value)) {
    return { error: 'That\'s a folder link. Open the video itself in Drive and copy its link.' };
  }
  const drive =
    value.match(/\/file\/d\/([\w-]{10,})/) ||
    value.match(/(?:drive|docs)\.google\.com\/.*[?&]id=([\w-]{10,})/) ||
    value.match(/drive\.usercontent\.google\.com\/.*[?&]id=([\w-]{10,})/) ||
    value.match(/^([\w-]{25,})$/);
  if (drive) return { type: 'drive', id: drive[1] };
  if (/^https?:\/\/\S+$/i.test(value)) return { type: 'url', url: value, format: looksLikeHls(value) ? 'hls' : 'file' };
  return { error: 'Paste a Google Drive link, an HLS (.m3u8) link, or a direct link to a video file.' };
}

function looksLikeHls(url) {
  try {
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** For links without a telling extension, peek at the first bytes to spot an HLS playlist. */
export async function detectUrlFormat(source) {
  if (source.format === 'hls' || /\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(new URL(source.url).pathname)) return source;
  try {
    const res = await fetch(source.url, { headers: { Range: 'bytes=0-6' }, signal: AbortSignal.timeout(5000) });
    // Read only the first chunk, in case the host ignores the Range header.
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel();
    if (new TextDecoder().decode(value?.slice(0, 7)) === '#EXTM3U') return { ...source, format: 'hls' };
  } catch {
    // Cross-origin hosts often block this check; play it as a regular file.
  }
  return source;
}

export function sourceSrc(source) {
  // Drive sources are served by the streaming service worker (sw.js) straight from Google.
  if (source.type !== 'drive') return source.url;
  const id = encodeURIComponent(source.id);
  return source.format === 'hls' ? `/media/drive-hls/${id}/` : `/media/drive/${id}`;
}

export function urlTitle(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || '') || 'Video';
  } catch {
    return 'Video';
  }
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export function extractCode(input) {
  const value = String(input || '').trim();
  const fromLink = value.match(/\/party\/([A-Za-z0-9]{4,12})/);
  const code = (fromLink ? fromLink[1] : value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length >= 4 ? code : '';
}

const NAME_KEY = 'driveparty:name';

export function savedName() {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {}
}

let toastTimer;
export function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}
