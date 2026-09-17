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
  if (/^https?:\/\/\S+$/i.test(value)) return { type: 'url', url: value };
  return { error: 'Paste a Google Drive video link (or a direct link to a video file).' };
}

export function sourceSrc(source) {
  return source.type === 'drive' ? `/api/drive/${encodeURIComponent(source.id)}/stream` : source.url;
}

/** Resolve a title for a source, validating Drive files are reachable. */
export async function inspectSource(source) {
  if (source.type !== 'drive') {
    const name = decodeURIComponent(new URL(source.url).pathname.split('/').pop() || '') || 'Video';
    return { ok: true, title: name };
  }
  const res = await fetch(`/api/drive/${encodeURIComponent(source.id)}/info`);
  const data = await res.json().catch(() => ({ ok: false, error: 'Could not check that file.' }));
  return data.ok ? { ok: true, title: data.name, size: data.size } : { ok: false, error: data.error };
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
