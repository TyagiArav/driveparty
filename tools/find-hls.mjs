#!/usr/bin/env node
// Find HLS (.m3u8) streams in a web page's HTML. No dependencies (Node 18+).
//
//   node tools/find-hls.mjs <page-url> [--browser] [--wait 12] [--show] [--depth 2] [--referer <url>] [--no-scripts] [--json]
//
// Scans the page's markup, inline scripts, linked scripts and nested iframes for playlist
// URLs (plain, JSON-escaped, URL-encoded or base64), then fetches each one to confirm it's HLS.
//
// That alone doesn't run the page's JavaScript. --browser also opens the page in headless Chrome
// (needs `npm install` for playwright-core, and Google Chrome), presses play, and records every
// playlist the player requests. --wait is how many seconds to watch; --show makes the window visible.

const TIMEOUT = 20_000;
const MAX_PAGES = 15;
const MAX_SCRIPTS = 25;
const MAX_BODY = 5e6;
const CONCURRENCY = 8;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const toggle = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args.splice(i, 1).length > 0;
};
const maxDepth = Number(flag('--depth') ?? 2);
const startReferer = flag('--referer');
const waitSeconds = Number(flag('--wait') ?? 12);
const useBrowser = toggle('--browser');
const showBrowser = toggle('--show');
const skipScripts = toggle('--no-scripts');
const asJson = toggle('--json');
const [startUrl] = args;

if (!startUrl || !/^https?:\/\//i.test(startUrl) || Number.isNaN(maxDepth) || Number.isNaN(waitSeconds)) {
  console.error('usage: find-hls.mjs <page-url> [--browser] [--wait 12] [--show] [--depth 2] [--referer <url>] [--no-scripts] [--json]');
  process.exit(1);
}

const log = (...msg) => asJson || console.error(...msg);

function headersFor(referer) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) {
    headers.Referer = referer;
    headers.Origin = new URL(referer).origin;
  }
  return headers;
}

async function fetchText(url, referer) {
  const res = await fetch(url, { headers: headersFor(referer), signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: (await res.text()).slice(0, MAX_BODY), url: res.url };
}

const isPlaylist = (text) => text.trimStart().startsWith('#EXTM3U');

const decodeEntities = (text) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');

/** The text itself plus anything hidden inside it: escaped, URL-encoded and base64'd URLs. */
function views(text) {
  const plain = decodeEntities(
    text
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\x([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
  );
  const hidden = [];
  for (const [encoded] of plain.matchAll(/https?%3A%2F%2F[^\s"'<>&\\]+/gi)) {
    try {
      hidden.push(decodeURIComponent(encoded));
    } catch {}
  }
  // "aHR0c" is how base64 of "http" starts.
  for (const [encoded] of plain.matchAll(/aHR0c[\w+/-]{16,}={0,2}/g)) {
    hidden.push(Buffer.from(encoded, 'base64').toString('latin1'));
  }
  return [plain, ...hidden];
}

const URL_CHARS = '[^\\s"\'<>`\\\\()\\[\\]{}|^]';
const ABSOLUTE = new RegExp(`(?:https?:)?//${URL_CHARS}+?\\.m3u8(?:[?#]${URL_CHARS}*)?`, 'gi');
const RELATIVE = new RegExp(`["'=(]\\s*((?!//)[\\w./~%-][^"'\\s<>()=,;+\`\\\\]*\\.m3u8(?:\\?${URL_CHARS}*)?)`, 'gi');
const NOT_HLS_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|ogg|mp3|m4a|wav|mpd)$/i;

function resolve(raw, base) {
  try {
    const url = new URL(raw.trim().replace(/[.,;]+$/, ''), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** Every URL in `text` that looks like an HLS playlist, resolved against `base`. */
function findPlaylistUrls(text, base) {
  const found = new Set();
  for (const view of views(text)) {
    for (const [match] of view.matchAll(ABSOLUTE)) found.add(resolve(match, base));
    for (const [, match] of view.matchAll(RELATIVE)) {
      // A URL-encoded absolute URL is not a relative path; its decoded form is already in `views`.
      if (!/%3A%2F%2F/i.test(match)) found.add(resolve(match, base));
    }
  }
  found.delete(null);
  return found;
}

const tagAttrs = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(([, name, a, b, c]) => [
      name.toLowerCase(),
      decodeEntities(a ?? b ?? c),
    ])
  );

/** Pull out what the markup points at: media elements, iframes to follow, scripts to read. */
function parseHtml(html, pageUrl) {
  const tags = [...html.matchAll(/<(video|source|iframe|embed|script|base)\b[^>]*>/gi)].map(([tag, name]) => ({
    name: name.toLowerCase(),
    attrs: tagAttrs(tag),
  }));
  const base = resolve(tags.find((t) => t.name === 'base' && t.attrs.href)?.attrs.href ?? '', pageUrl) ?? pageUrl;
  const media = new Set();
  const frames = new Set();
  const scripts = new Set();
  for (const { name, attrs } of tags) {
    const src = resolve(attrs.src || attrs['data-src'] || '', base);
    if (!src || !(attrs.src || attrs['data-src'])) continue;
    if (name === 'script') scripts.add(src);
    else if (name === 'iframe' || name === 'embed') frames.add(src);
    // Players often serve playlists from extensionless URLs, so anything not plainly a file gets probed.
    else if (/mpegurl/i.test(attrs.type || '') || !NOT_HLS_EXT.test(new URL(src).pathname)) media.add(src);
  }
  return { base, media, frames, scripts };
}

/** url -> { url, referer, via, text? } for everything worth probing. `text` is the playlist body if we already have it. */
const candidates = new Map();
const addCandidate = (url, referer, via, text) => {
  // A playlist the browser actually loaded beats a guess from the markup.
  if (!candidates.has(url) || (text && !candidates.get(url).text)) candidates.set(url, { url, referer, via, text });
};

async function crawl() {
  const seen = new Set([startUrl]);
  const queue = [{ url: startUrl, referer: startReferer, depth: 0 }];
  while (queue.length && seen.size <= MAX_PAGES) {
    const page = queue.shift();
    let html;
    try {
      ({ text: html, url: page.url } = await fetchText(page.url, page.referer));
    } catch (err) {
      log(`  couldn't load ${page.url}: ${err.message}`);
      continue;
    }
    if (isPlaylist(html)) {
      addCandidate(page.url, page.referer, 'direct link');
      continue;
    }
    log(`Scanning ${page.url}`);
    const { base, media, frames, scripts } = parseHtml(html, page.url);
    for (const url of media) addCandidate(url, page.url, 'video element');
    for (const url of findPlaylistUrls(html, base)) addCandidate(url, page.url, 'page source');

    if (!skipScripts) {
      const loaded = await Promise.allSettled([...scripts].slice(0, MAX_SCRIPTS).map((src) => fetchText(src, page.url)));
      for (const result of loaded) {
        if (result.status !== 'fulfilled') continue;
        // Paths inside a script are relative to the document that runs it, not to the script file.
        for (const url of findPlaylistUrls(result.value.text, base)) addCandidate(url, page.url, 'linked script');
      }
    }

    if (page.depth >= maxDepth) continue;
    for (const url of frames) {
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push({ url, referer: page.url, depth: page.depth + 1 });
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open the page in headless Chrome, press play, and record the playlists it requests. */
async function browse() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw new Error('--browser needs playwright-core. Run `npm install` in this project first.');
  }
  const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
  // Prefer the Chrome that's already installed; fall back to a Playwright-managed Chromium if there is one.
  const browser = await chromium.launch({ channel: 'chrome', headless: !showBrowser, args }).catch(() =>
    chromium.launch({ headless: !showBrowser, args }).catch(() => {
      throw new Error('--browser needs Google Chrome installed (or run `npx playwright-core install chromium`).');
    })
  );
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    // Play buttons on some sites open ad pop-ups; they're never what we want.
    context.on('page', (popup) => popup !== page && popup.close().catch(() => {}));

    let lastHit = 0;
    const pending = new Set();
    context.on('response', (response) => {
      const url = response.url();
      const type = response.headers()['content-type'] || '';
      if (!/\.m3u8(\?|#|$)/i.test(url) && !/mpegurl/i.test(type)) return;
      const request = response.request();
      const work = (async () => {
        const text = await response.text().catch(() => '');
        if (!isPlaylist(text)) return;
        // The Referer the browser really sent is the one the host accepts.
        const referer = (await request.headerValue('referer').catch(() => null)) || request.frame()?.url() || page.url();
        addCandidate(url, referer, 'network request', text);
        lastHit = Date.now();
      })();
      pending.add(work);
      work.finally(() => pending.delete(work));
    });

    log(`Opening ${startUrl} in Chrome`);
    await page
      .goto(startUrl, { referer: startReferer, waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch((err) => log(`  page didn't finish loading: ${err.message.split('\n')[0]}`));

    const startPlayback = () =>
      Promise.all(
        page.frames().map((frame) =>
          frame
            .evaluate(() => {
              for (const video of document.querySelectorAll('video')) {
                video.muted = true;
                video.play().catch(() => {});
              }
            })
            .catch(() => {})
        )
      );
    const clickPlayer = async () => {
      // No stream yet: click the middle of the biggest player-like element, as a viewer would.
      let best = null;
      for (const el of await page.$$('video, iframe')) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width * box.height > (best ? best.width * best.height : 10_000)) best = box;
      }
      if (best) await page.mouse.click(best.x + best.width / 2, best.y + best.height / 2).catch(() => {});
    };

    const opened = Date.now();
    const deadline = opened + waitSeconds * 1000;
    let clicked = false;
    await sleep(1000);
    while (Date.now() < deadline) {
      await startPlayback();
      // Once playlists show up, give the player a moment to fetch the renditions, then stop.
      if (lastHit && Date.now() - lastHit > 2500) break;
      if (!lastHit && !clicked && Date.now() > opened + Math.min(3000, (waitSeconds * 1000) / 2)) {
        clicked = true;
        await clickPlayer();
      }
      await sleep(500);
    }
    await Promise.all(pending);

    // The rendered DOM can hold URLs that weren't in the HTML the server sent.
    for (const frame of page.frames()) {
      const html = await frame.content().catch(() => '');
      const frameUrl = frame.url();
      if (!html || !/^https?:/.test(frameUrl)) continue;
      const { base, media } = parseHtml(html, frameUrl);
      for (const url of media) addCandidate(url, frameUrl, 'video element');
      for (const url of findPlaylistUrls(html, base)) addCandidate(url, frameUrl, 'rendered page');
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

const attrs = (line) =>
  Object.fromEntries(
    [...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')])
  );

function describe(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  lines.forEach((line, i) => {
    if (!line.startsWith('#EXT-X-STREAM-INF')) return;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    const a = attrs(line);
    if (uri) variants.push({ url: resolve(uri, base), resolution: a.RESOLUTION || null, bandwidth: Number(a.BANDWIDTH) || 0 });
  });
  // Audio and subtitle tracks that live in playlists of their own.
  const tracks = lines
    .filter((l) => l.startsWith('#EXT-X-MEDIA'))
    .map(attrs)
    .filter((a) => a.URI)
    .map((a) => ({ url: resolve(a.URI, base), type: a.TYPE?.toLowerCase(), name: a.NAME || a.LANGUAGE || null }));
  if (variants.length) {
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { kind: 'master', variants, tracks };
  }
  const durations = lines.filter((l) => l.startsWith('#EXTINF')).map((l) => parseFloat(l.slice(8)) || 0);
  const key = lines.findLast((l) => l.startsWith('#EXT-X-KEY'));
  return {
    kind: 'media',
    segments: durations.length,
    duration: Math.round(durations.reduce((sum, d) => sum + d, 0)),
    live: !lines.includes('#EXT-X-ENDLIST'),
    encryption: key ? attrs(key).METHOD : 'NONE',
  };
}

/** Fetch a candidate and confirm it really is a playlist, bailing early if it's something else (e.g. an mp4). */
async function probe({ text: seen, ...candidate }) {
  if (seen) return { ...candidate, ok: true, ...describe(seen, candidate.url) };
  try {
    const res = await fetch(candidate.url, { headers: headersFor(candidate.referer), signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) return { ...candidate, ok: false, note: `HTTP ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      const head = text.trimStart();
      if ((head.length >= 7 && !isPlaylist(head)) || text.length > MAX_BODY) {
        await reader.cancel();
        break;
      }
    }
    if (!isPlaylist(text)) return { ...candidate, ok: false, note: `not a playlist (${res.headers.get('content-type') || 'unknown type'})` };
    return { ...candidate, url: res.url, ok: true, ...describe(text, res.url) };
  } catch (err) {
    return { ...candidate, ok: false, note: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

async function probeAll(list) {
  const results = [];
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(list.slice(i, i + CONCURRENCY).map(probe))));
  }
  return results;
}

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
const clock = (seconds) =>
  [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map((n) => String(n).padStart(2, '0')).join(':');

function summarize(stream) {
  if (stream.kind === 'master') {
    const audio = stream.tracks.filter((t) => t.type === 'audio').map((t) => t.name || 'unnamed');
    return (
      'master playlist: ' +
      stream.variants.map((v) => `${v.resolution || 'audio/unknown'} @ ${Math.round(v.bandwidth / 1000)} kbps`).join(', ') +
      (audio.length ? `; separate audio: ${[...new Set(audio)].join(', ')}` : '')
    );
  }
  const parts = [`media playlist (may be a single audio or video track): ${stream.segments} segments`, stream.live ? 'live' : clock(stream.duration)];
  if (stream.encryption !== 'NONE') parts.push(`encrypted (${stream.encryption})`);
  return parts.join(', ');
}

await crawl();
if (useBrowser) {
  try {
    await browse();
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
const probed = await probeAll([...candidates.values()]);

const streams = [...new Map(probed.filter((p) => p.ok).map((p) => [p.url, p])).values()];
// A rendition listed by a master playlist we also found isn't a separate stream.
const renditions = new Set(streams.flatMap((s) => [...(s.variants ?? []), ...(s.tracks ?? [])].map((v) => v.url)));
const found = streams
  .filter((s) => !renditions.has(s.url))
  // Masters first: a lone media playlist may be just one track (only the sound, say) of a stream.
  .sort((a, b) => (a.kind === 'master' ? 0 : 1) - (b.kind === 'master' ? 0 : 1));
// Only report failures that named themselves as playlists; probed <video> files that turned out to be mp4s are noise.
const failed = probed.filter((p) => !p.ok && /\.m3u8/i.test(p.url));

if (asJson) {
  console.log(JSON.stringify({ page: startUrl, streams: found, unconfirmed: failed }, null, 2));
} else {
  console.log(found.length ? `\nFound ${found.length} HLS stream${found.length === 1 ? '' : 's'}:\n` : '\nNo HLS streams found.');
  found.forEach((stream, i) => {
    console.log(`${i + 1}. ${stream.url}`);
    console.log(`   ${summarize(stream)}`);
    console.log(`   found in ${stream.via}${stream.referer ? ` of ${stream.referer}` : ''}`);
    console.log(`   node tools/download-hls.mjs ${quote(stream.url)}${stream.referer ? ` --referer ${quote(stream.referer)}` : ''}\n`);
  });
  if (failed.length) {
    console.log('Looked like HLS but could not be confirmed:');
    for (const f of failed) console.log(`   ${f.url}\n     ${f.note}`);
  }
  if (!found.length && !failed.length) {
    console.log(
      useBrowser
        ? 'The player never requested a playlist. It may need a sign-in, a longer --wait, or use DASH/DRM instead of HLS.'
        : 'The page may load its stream with JavaScript after it opens. Try again with --browser.'
    );
  }
}

process.exit(found.length ? 0 : 1);
