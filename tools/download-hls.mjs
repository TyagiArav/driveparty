#!/usr/bin/env node
// Download an HLS (.m3u8) stream to a single file. No dependencies (Node 18+).
//
//   node tools/download-hls.mjs <m3u8-url> [output] [--referer <url>] [--quality lowest] [--audio <language>]
//
// Handles master playlists, AES-128 encrypted segments, fMP4 (EXT-X-MAP) and byte-range segments.
// Streams that keep sound in a separate audio playlist get both tracks downloaded and joined with
// ffmpeg (if it's installed; otherwise the two files are left side by side).
// Does not handle DRM (SAMPLE-AES / Widevine / FairPlay).

import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { once } from 'node:events';

const CONCURRENCY = 8;
const RETRIES = 3;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const referer = flag('--referer');
const quality = flag('--quality') || 'highest';
const audioLanguage = flag('--audio');
const [url, outArg] = args;

if (!url) {
  console.error('usage: download-hls.mjs <m3u8-url> [output] [--referer <url>] [--quality lowest|highest] [--audio <language>]');
  process.exit(1);
}

const headers = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
};
if (referer) {
  headers.Referer = referer;
  headers.Origin = new URL(referer).origin;
}

async function get(target, extra = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(target, { headers: { ...headers, ...extra } });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${target}`);
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

async function getPlaylist(target) {
  const res = await get(target);
  const text = await res.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    throw new Error(
      `Not an HLS playlist (ended up at ${res.url}, content-type ${res.headers.get('content-type')}).\n` +
        'The link may have expired, or the host may require the embedding page as --referer.'
    );
  }
  // Resolve relative URIs against the final URL, after redirects.
  return { text, base: res.url };
}

const attrs = (line) =>
  Object.fromEntries(
    [...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')])
  );

function pickVariant(text, base) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith('#'));
    const a = attrs(line);
    variants.push({
      bandwidth: Number(a.BANDWIDTH) || 0,
      url: new URL(uri.trim(), base).href,
      audioGroup: a.AUDIO,
      // Only trust CODECS to say "no video" when it's there; plenty of playlists leave it out.
      audioOnly: Boolean(a.CODECS) && !a.RESOLUTION && !/avc|hvc|hev|vp0?9|av01|dvh/i.test(a.CODECS),
    });
  });
  if (!variants.length) return null;
  // Audio-only variants are a fallback for bad connections, never what "the video" means.
  const withVideo = variants.filter((v) => !v.audioOnly);
  const pool = (withVideo.length ? withVideo : variants).sort((a, b) => a.bandwidth - b.bandwidth);
  return quality === 'lowest' ? pool[0] : pool.at(-1);
}

/** The separate audio playlist that goes with a variant, if its sound isn't muxed into the video. */
function pickAudio(text, base, variant) {
  if (!variant.audioGroup) return null;
  const tracks = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('#EXT-X-MEDIA'))
    .map(attrs)
    .filter((a) => a.TYPE === 'AUDIO' && a['GROUP-ID'] === variant.audioGroup && a.URI);
  const track =
    (audioLanguage && tracks.find((a) => [a.LANGUAGE, a.NAME].some((v) => v?.toLowerCase().startsWith(audioLanguage.toLowerCase())))) ||
    tracks.find((a) => a.DEFAULT === 'YES') ||
    tracks[0];
  return track && { url: new URL(track.URI, base).href, name: track.NAME || track.LANGUAGE || 'audio' };
}

/** Fetch a URL's body, or just `range` ({ offset, length }) of it. */
async function getBytes(target, range) {
  if (!range) return Buffer.from(await (await get(target)).arrayBuffer());
  const res = await get(target, { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` });
  const data = Buffer.from(await res.arrayBuffer());
  // A server that ignores Range answers 200 with the whole file.
  return res.status === 206 ? data : data.subarray(range.offset, range.offset + range.length);
}

/** Parse "<length>[@<offset>]"; without an offset the range starts where the previous one ended. */
function parseRange(value, previousEnd) {
  const [length, offset] = value.split('@').map(Number);
  return { offset: Number.isNaN(offset ?? NaN) ? previousEnd : offset, length };
}

function parseMedia(text, base) {
  const segments = [];
  let key = null;
  let map = null;
  let seq = 0;
  let range = null;
  let rangeEnd = 0; // end of the last byte range, for ranges given without an offset
  let rangeUrl = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) seq = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-KEY')) {
      const a = attrs(line);
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { url: new URL(a.URI, base).href, iv: a.IV };
      else throw new Error(`Unsupported encryption: ${a.METHOD} (DRM-protected stream)`);
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = attrs(line);
      map = { url: new URL(a.URI, base).href, range: a.BYTERANGE ? parseRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXT-X-BYTERANGE')) range = line.slice(line.indexOf(':') + 1).trim();
    else if (!line.startsWith('#')) {
      const url = new URL(line, base).href;
      const segment = { url, key, seq: seq++, range: null };
      if (range) {
        segment.range = parseRange(range, url === rangeUrl ? rangeEnd : 0);
        rangeEnd = segment.range.offset + segment.range.length;
        rangeUrl = url;
        range = null;
      }
      segments.push(segment);
    }
  }
  return { segments, map };
}

const keyCache = new Map();
function fetchKey(keyUrl) {
  if (!keyCache.has(keyUrl)) {
    keyCache.set(keyUrl, get(keyUrl).then(async (r) => Buffer.from(await r.arrayBuffer())));
  }
  return keyCache.get(keyUrl);
}

async function fetchSegment(seg) {
  const data = await getBytes(seg.url, seg.range);
  if (!seg.key) return data;
  // Per the HLS spec, a missing IV means the media sequence number, big-endian.
  const iv = seg.key.iv ? Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex') : Buffer.alloc(16);
  if (!seg.key.iv) iv.writeUInt32BE(seg.seq, 12);
  const decipher = createDecipheriv('aes-128-cbc', await fetchKey(seg.key.url), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** Download every segment of a media playlist into one file. `name` picks the file name once the container is known. */
async function download(playlistUrl, name, label) {
  const { text, base } = await getPlaylist(playlistUrl);
  const { segments, map } = parseMedia(text, base);
  if (!segments.length) throw new Error('Playlist has no segments');

  const file = name(map ? 'mp4' : 'ts');
  const out = createWriteStream(file);
  const write = async (buf) => {
    if (!out.write(buf)) await once(out, 'drain');
  };

  if (map) await write(await getBytes(map.url, map.range));

  let bytes = 0;
  for (let i = 0; i < segments.length; i += CONCURRENCY) {
    const batch = await Promise.all(segments.slice(i, i + CONCURRENCY).map(fetchSegment));
    for (const buf of batch) {
      await write(buf);
      bytes += buf.length;
    }
    const done = Math.min(i + CONCURRENCY, segments.length);
    process.stdout.write(`\r${label}${done}/${segments.length} segments, ${(bytes / 1e6).toFixed(1)} MB`);
  }

  out.end();
  await once(out, 'finish');
  process.stdout.write('\n');
  return file;
}

const master = await getPlaylist(url);
const variant = pickVariant(master.text, master.base);
const audio = variant && pickAudio(master.text, master.base, variant);
if (variant) console.log(`Variant: ${Math.round(variant.bandwidth / 1000)} kbps${variant.audioOnly ? ' (audio only)' : ''}`);

if (!audio) {
  const output = await download(variant?.url ?? url, (ext) => outArg || `video.${ext}`, '');
  console.log(`Saved ${output}`);
  if (!variant) console.log('This was a single media playlist. If it has no picture (or no sound), download the master playlist instead.');
} else {
  // Sound lives in its own playlist: fetch both, then join them without re-encoding.
  console.log(`Audio track: ${audio.name}`);
  const output = outArg || 'video.mp4';
  const stem = output.replace(/\.[^./]+$/, '');
  const videoFile = await download(variant.url, (ext) => `${stem}.video.${ext}`, 'video: ');
  const audioFile = await download(audio.url, (ext) => `${stem}.audio.${ext}`, 'audio: ');
  const mux = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', videoFile, '-i', audioFile, '-map', '0:v', '-map', '1:a', '-c', 'copy', output], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (mux.status === 0) {
    await Promise.all([rm(videoFile), rm(audioFile)]);
    console.log(`Saved ${output}`);
  } else {
    console.log(
      mux.error?.code === 'ENOENT'
        ? `ffmpeg isn't installed, so the tracks weren't joined. Saved ${videoFile} and ${audioFile}.`
        : `ffmpeg couldn't join the tracks. Kept ${videoFile} and ${audioFile}.`
    );
    process.exitCode = 1;
  }
}
