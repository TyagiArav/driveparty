import {
  parseSource, detectUrlFormat, sourceSrc, urlTitle, subtitlesToVtt, formatTime, savedName, saveName, toast, copyText,
} from './common.js';
import {
  initGoogle, getMe, signIn, signOut, checkDriveAccess, checkDriveHls, checkLinkShared, enableLinkSharing,
  openDriveFile, pickDriveVideo, pickDriveSubtitles, pickHlsFiles, ensureMediaWorker, accessMessage, NeedsConsentError,
} from './google.js';

const $ = (id) => document.getElementById(id);
const code = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
const params = new URLSearchParams(location.search);

const video = $('video');
const stage = $('stage');
const overlay = $('overlay');
const overlayBox = $('overlay-box');
const messagesEl = $('messages');
const chatInput = $('chat-input');

const socket = io({ autoConnect: false });

let me = null;
let myName = '';
let room = null; // { code, source, playback, users }
let sourceKey = '';
let clockOffset = 0; // serverTime - localTime, in ms
let pendingSeek = null; // a seek we made ourselves, so `seeked` doesn't echo it back
let lastHardCorrection = 0;
let playBlocked = false;
let videoFailed = false;
let unread = 0;
let firstJoin = true;
let hls = null; // hls.js instance for HLS sources
let relaying = false; // playing a link's stream through the server (see relayStream)
let autoPickedKey = ''; // source the Drive picker was already opened for automatically

// ---------------------------------------------------------------------------
// Clock + playback sync
// ---------------------------------------------------------------------------

const serverNow = () => Date.now() + clockOffset;

async function syncClock() {
  const samples = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    const serverTime = await new Promise((resolve) => socket.timeout(3000).emit('clock', null, (err, t) => resolve(err ? null : t)));
    const t1 = Date.now();
    if (serverTime != null) samples.push({ rtt: t1 - t0, offset: serverTime - (t0 + t1) / 2 });
  }
  if (samples.length) clockOffset = samples.sort((a, b) => a.rtt - b.rtt)[0].offset;
}

function expectedTime() {
  const p = room.playback;
  return p.paused ? p.time : p.time + ((serverNow() - p.at) / 1000) * p.rate;
}

function seekTo(time) {
  pendingSeek = time;
  video.currentTime = time;
}

/** Make the local video match the party's shared playback state. */
function applyPlayback() {
  if (!room || videoFailed || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const p = room.playback;
  const duration = video.duration;
  let target = expectedTime();
  const atEnd = Number.isFinite(duration) && target >= duration - 0.25;
  if (Number.isFinite(duration)) target = Math.min(target, duration);

  if (Math.abs(video.currentTime - target) > (p.paused ? 0.15 : 0.5)) seekTo(target);
  video.playbackRate = 1;

  if (p.paused || atEnd) {
    if (!video.paused) video.pause();
    setPlayBlocked(false);
  } else if (video.paused) {
    video.play().then(() => setPlayBlocked(false)).catch((err) => {
      if (err.name === 'NotAllowedError') setPlayBlocked(true);
    });
  }
}

/** Tell the party about something this user did, updating local state right away. */
function sendControl(action) {
  const time = video.currentTime;
  const paused = action === 'play' ? false : action === 'pause' ? true : room.playback.paused;
  room.playback = { paused, time, at: serverNow(), rate: 1 };
  socket.emit('control', { action, time });
}

video.addEventListener('play', () => {
  if (room && room.playback.paused) sendControl('play');
});

video.addEventListener('pause', () => {
  // Chrome pauses muted videos in hidden tabs on its own; that isn't this viewer pausing the party.
  if (document.hidden && video.muted) return;
  if (room && !room.playback.paused) sendControl('pause');
});

video.addEventListener('seeked', () => {
  const ours = pendingSeek !== null && Math.abs(video.currentTime - pendingSeek) < 0.5;
  pendingSeek = null;
  if (ours || !room) return;
  if (Math.abs(video.currentTime - expectedTime()) > 0.75) sendControl('seek');
});

// Keep everyone locked together: nudge speed for small drift, jump for large drift.
setInterval(() => {
  if (!room || videoFailed || playBlocked || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
  const p = room.playback;

  if (p.paused !== video.paused && !video.seeking && !video.ended) {
    applyPlayback();
    return;
  }
  if (p.paused || video.paused || video.seeking || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    if (video.playbackRate !== 1) video.playbackRate = 1;
    return;
  }

  const drift = expectedTime() - video.currentTime; // positive: we're behind
  if (Math.abs(drift) > 2 && Date.now() - lastHardCorrection > 4000) {
    lastHardCorrection = Date.now();
    video.playbackRate = 1;
    seekTo(expectedTime());
  } else if (Math.abs(drift) > 0.3) {
    video.playbackRate = drift > 0 ? 1.08 : 0.92;
  } else if (video.playbackRate !== 1) {
    video.playbackRate = 1;
  }
}, 1000);

// ---------------------------------------------------------------------------
// Video source + overlays
// ---------------------------------------------------------------------------

function setSource(source) {
  const key = `${source.type}:${source.format}:${source.type === 'drive' ? source.id : source.url}`;
  $('video-title').textContent = source.title || 'Untitled video';
  document.title = `${source.title || 'Party'} · DriveParty`;
  if (key === sourceKey) return applyPlayback();

  sourceKey = key;
  videoFailed = false;
  relaying = false;
  destroyHls();
  video.removeAttribute('src');
  video.load();
  if (source.type === 'drive') prepareDriveSource(source, key);
  else loadVideo(source);
}

function retrySource() {
  sourceKey = '';
  setSource(room.source);
}

function destroyHls() {
  hls?.destroy();
  hls = null;
}

let hlsLibrary = null;
function loadHlsLibrary() {
  hlsLibrary ??= new Promise((resolve, reject) => {
    const script = Object.assign(document.createElement('script'), { src: '/vendor/hls.min.js' });
    script.onload = () => resolve(window.Hls);
    script.onerror = () => { hlsLibrary = null; reject(new Error('Couldn\'t load the HLS player.')); };
    document.head.append(script);
  });
  return hlsLibrary;
}

async function loadVideo(source) {
  showLoading();
  const src = relaying ? `/relay/party/${room.code}` : sourceSrc(source);
  if (source.format !== 'hls') {
    video.src = src;
    video.load();
    return;
  }

  const key = sourceKey;
  let Hls;
  try {
    Hls = await loadHlsLibrary();
  } catch (err) {
    return showProblem('Can\'t play this stream', err.message);
  }
  if (key !== sourceKey) return;

  if (Hls.isSupported()) {
    hls = new Hls({ maxBufferLength: 60 });
    let recoveredMedia = false;
    let retriedNetwork = false;
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recoveredMedia) {
        recoveredMedia = true;
        return hls.recoverMediaError();
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !retriedNetwork && data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
        retriedNetwork = true;
        return hls.startLoad();
      }
      if (source.type === 'url' && !relaying) return relayStream(source);
      handleHlsFailure(source, data);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari's built-in HLS. It bypasses the service worker, so it only works for links, not Drive.
    if (source.type === 'drive') {
      return showProblem('Can\'t play this stream here', 'This browser can\'t play HLS streams stored in Drive. Try Chrome, Edge, Firefox or a recent Safari.');
    }
    video.src = src;
  } else {
    showProblem('Can\'t play this stream', 'This browser doesn\'t support HLS streams.');
  }
}

/** Hosts that turn away other websites (CORS) can still be played through the server. */
function relayStream(source) {
  relaying = true;
  destroyHls();
  loadVideo(source);
}

async function handleHlsFailure(source, data) {
  const key = sourceKey;
  videoFailed = true;
  destroyHls();
  if (source.type === 'drive') {
    // Usually a file this viewer can't open yet; the access flow explains what to do.
    const access = await checkDriveHls(source.id);
    if (key !== sourceKey) return;
    if (!access.ok) return retrySource();
  }
  const status = data.response?.code;
  if (data.details === 'manifestLoadError' || data.details === 'manifestParsingError') {
    return showProblem(
      'Couldn\'t load this stream',
      source.type === 'url'
        ? `The playlist didn't load${status ? ` (HTTP ${status})` : ''}. The link may have expired, or its host may only serve the website it came from.`
        : 'The playlist file couldn\'t be read.',
    );
  }
  if (data.type === 'networkError') return showProblem('Lost connection to the stream', `A part of the stream failed to load${status ? ` (HTTP ${status})` : ''}.`);
  showProblem('This stream can\'t be played', 'Your browser can\'t decode this stream\'s video or audio format.');
}

/** Each viewer streams Drive videos with their own Google account, so check they can open this one. */
async function prepareDriveSource(source, key) {
  showLoading('Opening from Google Drive…');
  let access;
  try {
    await ensureMediaWorker();
    access = await checkDriveAccess(source.id);
  } catch (err) {
    if (key === sourceKey) showProblem('Can\'t play video here', err.message);
    return;
  }
  if (key !== sourceKey) return;
  if (access.ok && source.format === 'hls') {
    showLoading('Checking stream files…');
    access = await checkDriveHls(source.id);
    if (key !== sourceKey) return;
  }
  if (access.ok) return loadVideo(source);

  if (access.reason === 'hls-missing') {
    const count = access.missing.length;
    const message = el('p', {
      textContent: access.folderId
        ? `This stream is made of many files, and ${count} of them ${count === 1 ? 'hasn\'t' : 'haven\'t'} been opened with DriveParty on your account yet. Select every file in the stream's folder to continue.`
        : 'This stream is made of many files, but its folder isn\'t shared with you. Ask the owner to share the whole folder.',
    });
    const select = el('button', { className: 'btn primary', textContent: 'Select the stream files' });
    select.addEventListener('click', async () => {
      select.disabled = true;
      try {
        const picked = await pickHlsFiles({ folderId: access.folderId });
        if (picked) retrySource();
      } catch (err) {
        message.textContent = err.message;
      } finally {
        select.disabled = false;
      }
    });
    showOverlay(access.folderId ? [el('h3', { textContent: 'Open the stream files' }), message, select] : [el('h3', { textContent: 'Can\'t open this stream' }), message]);
    return;
  }

  if (access.reason === 'signed-out') {
    let consent = false;
    const button = el('button', { className: 'btn google' }, ['Sign in with Google']);
    button.addEventListener('click', () => {
      signIn({ consent })
        .then(() => key === sourceKey && retrySource())
        .catch((err) => {
          consent = err instanceof NeedsConsentError;
          if (consent) button.textContent = 'Finish signing in';
          toast(err.message);
        });
    });
    showOverlay([
      el('h3', { textContent: 'Sign in to watch' }),
      el('p', { textContent: 'Everyone streams the video from Google Drive with their own account. Sign in with the Google account the video is shared with.' }),
      button,
    ]);
    return;
  }

  if (access.reason === 'no-access') {
    const account = await getMe();
    if (key !== sourceKey) return;
    const message = el('p', { textContent: `Select the video in Google's picker so DriveParty can open it. It needs to be shared with ${account.email || 'your Google account'}.` });
    const open = el('button', { className: 'btn primary', textContent: 'Open it from Google Drive' });
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        const result = await openDriveFile(source.id);
        if (result.ok) return retrySource();
        message.textContent = accessMessage(result.reason, account.email);
      } catch (err) {
        message.textContent = err.message;
      } finally {
        open.disabled = false;
      }
    });
    const switchAccount = el('button', { className: 'link-btn', textContent: 'Use a different Google account' });
    switchAccount.addEventListener('click', () => signOut().then(retrySource));
    showOverlay([el('h3', { textContent: 'Open this video' }), message, open, switchAccount]);
    // Bring up the picker, already narrowed to the party's video, without waiting for a click.
    if (autoPickedKey !== key) {
      autoPickedKey = key;
      open.click();
    }
    return;
  }

  showProblem(access.reason === 'not-video' ? 'This file isn\'t a video' : 'Couldn\'t reach Google Drive', accessMessage(access.reason));
}

function showOverlay(content) {
  overlayBox.replaceChildren(...content);
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function showLoading(text = 'Loading video…') {
  showOverlay([el('div', { className: 'spinner' }), el('p', { textContent: text })]);
}

function showProblem(heading, message) {
  const retry = el('button', { className: 'btn primary', textContent: 'Retry' });
  retry.addEventListener('click', retrySource);
  const change = el('button', { className: 'btn', textContent: 'Change video' });
  change.addEventListener('click', openChangeModal);
  showOverlay([
    el('h3', { textContent: heading }),
    el('p', { textContent: message }),
    el('div', { className: 'row' }, [retry, change]),
  ]);
}

function setPlayBlocked(blocked) {
  if (blocked === playBlocked) return;
  playBlocked = blocked;
  if (!blocked) return hideOverlay();
  const button = el('button', { className: 'btn primary', textContent: 'Start watching' });
  button.addEventListener('click', () => {
    playBlocked = false;
    hideOverlay();
    video.play().catch(() => setPlayBlocked(true));
  });
  showOverlay([
    el('h3', { textContent: 'The party is already playing' }),
    el('p', { textContent: 'Your browser needs a click before it will play video.' }),
    button,
  ]);
}

video.addEventListener('loadedmetadata', () => {
  if (!playBlocked) hideOverlay();
  applyPlayback();
});

video.addEventListener('error', async () => {
  if (!room || !video.getAttribute('src') || hls) return; // hls.js reports its own errors
  if (room.source.type === 'url' && room.source.format === 'hls' && !relaying) return relayStream(room.source);
  videoFailed = true;
  const key = sourceKey;
  showLoading();

  if (room.source.type === 'drive') {
    const access = await checkDriveAccess(room.source.id);
    if (key !== sourceKey) return;
    // Lost access or got signed out: show the sign-in / open-file steps again.
    if (!access.ok) return retrySource();
  }
  if (video.error?.code === MediaError.MEDIA_ERR_NETWORK) {
    return showProblem('Lost connection to the video', 'The stream was interrupted.');
  }
  showProblem(
    'This video can\'t be played',
    room.source.type === 'drive'
      ? 'Your browser can\'t play this file\'s format. MP4 (H.264 + AAC audio) or WebM work best. MKV, HEVC or AC3/DTS audio usually won\'t.'
      : room.source.format === 'hls'
        ? 'The stream didn\'t load. The link may have expired.'
        : 'Check that the link points directly to a video file or an .m3u8 stream.',
  );
});

let pillTimer;
function showPill(text, sticky = false) {
  const pill = $('status-pill');
  pill.textContent = text;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  if (!sticky) pillTimer = setTimeout(() => pill.classList.remove('show'), 2500);
}

function hidePill() {
  $('status-pill').classList.remove('show');
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

socket.on('connect', async () => {
  await syncClock();
  socket.emit('join', { code, name: myName }, onJoined);
});

socket.on('disconnect', (reason) => {
  if (reason !== 'io client disconnect') showPill('Connection lost, reconnecting…', true);
});

function onJoined(res) {
  if (res.error) {
    socket.disconnect();
    if (firstJoin) {
      $('join-error').textContent = res.error;
      $('join-submit').disabled = false;
      $('join-submit').textContent = 'Join party';
    } else {
      showOverlay([el('h3', { textContent: 'Party ended' }), el('p', { textContent: res.error })]);
    }
    return;
  }

  me = res.you;
  room = res.room;
  hidePill();
  $('join-modal').classList.add('hidden');

  renderUsers(room.users);
  messagesEl.replaceChildren();
  unread = 0;
  updateUnread();
  for (const message of res.messages) addMessage(message, false);
  setSource(room.source);
  applySubtitles();

  if (firstJoin) {
    firstJoin = false;
    if (params.has('invite')) {
      history.replaceState(null, '', location.pathname);
      openInviteModal();
    }
  }
}

socket.on('playback', ({ playback, by, action }) => {
  if (!room) return;
  room.playback = playback;
  applyPlayback();
  if (by !== me?.id) {
    const who = room.users.find((u) => u.id === by)?.name || 'Someone';
    const verb = action === 'play' ? 'played' : action === 'pause' ? 'paused' : `jumped to ${formatTime(playback.time)}`;
    showPill(`${who} ${verb}`);
  }
});

socket.on('source', ({ source, playback }) => {
  if (!room) return;
  room.source = source;
  room.playback = playback;
  room.subtitles = null;
  setSource(source);
  applySubtitles();
});

socket.on('subtitle-delay', (delay) => {
  if (!room?.subtitles) return;
  room.subtitles.delay = delay;
  applySubtitleDelay();
  showSubtitleDelay();
});

socket.on('subtitles', (subtitles) => {
  if (!room) return;
  room.subtitles = subtitles;
  applySubtitles();
});

socket.on('users', (users) => {
  if (!room) return;
  room.users = users;
  renderUsers(users);
});

socket.on('chat', (message) => addMessage(message, true));

// ---------------------------------------------------------------------------
// Chat + people
// ---------------------------------------------------------------------------

function renderUsers(users) {
  $('user-count').textContent = `· ${users.length} watching`;
  $('avatars').replaceChildren(
    ...users.slice(0, 5).map((u) => el('span', {
      className: 'avatar',
      textContent: u.name.slice(0, 1),
      title: u.id === me?.id ? `${u.name} (you)` : u.name,
      style: `background:${u.color}`,
    })),
  );
}

function addMessage(message, isNew) {
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  const mine = message.userId && message.userId === me?.id;

  let node;
  if (message.type === 'system') {
    node = el('div', { className: 'msg system', textContent: message.text });
  } else {
    const time = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const who = el('div', { className: 'who' }, [
      el('span', { textContent: mine ? `${message.name} (you)` : message.name, style: `color:${message.color}` }),
      el('time', { textContent: time }),
    ]);
    node = el('div', { className: `msg${mine ? ' mine' : ''}` }, [who, el('div', { className: 'body', textContent: message.text })]);
  }

  messagesEl.append(node);
  while (messagesEl.childElementCount > 300) messagesEl.firstElementChild.remove();
  if (nearBottom || mine || !isNew) messagesEl.scrollTop = messagesEl.scrollHeight;

  if (isNew && !mine && message.type === 'user' && !chatIsOpen()) {
    unread++;
    updateUnread();
    toast(`${message.name}: ${message.text.slice(0, 60)}`);
  }
}

function updateUnread() {
  const badge = $('unread');
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', unread === 0);
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text || !room) return;
  socket.emit('chat', text);
  chatInput.value = '';
});

const CHAT_KEY = 'driveparty:chat-open';
const chatIsOpen = () => !stage.classList.contains('chat-closed');

function setChatOpen(open) {
  stage.classList.toggle('chat-closed', !open);
  $('chat-btn').setAttribute('aria-pressed', String(open));
  try { localStorage.setItem(CHAT_KEY, open ? '1' : '0'); } catch {}
  if (open) {
    unread = 0;
    updateUnread();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

try { if (localStorage.getItem(CHAT_KEY) === '0') setChatOpen(false); } catch {}

$('chat-btn').addEventListener('click', () => {
  setChatOpen(!chatIsOpen());
  if (chatIsOpen() && matchMedia('(hover: hover)').matches) chatInput.focus();
});
$('chat-close').addEventListener('click', () => setChatOpen(false));

// ---------------------------------------------------------------------------
// Modals, fullscreen, keyboard
// ---------------------------------------------------------------------------

function openModal(id) {
  $(id).classList.remove('hidden');
}

function closeModals() {
  for (const modal of document.querySelectorAll('.modal:not(#join-modal)')) modal.classList.add('hidden');
}

document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeModals));
document.querySelectorAll('.modal:not(#join-modal)').forEach((m) => m.addEventListener('mousedown', (e) => {
  if (e.target === m) closeModals();
}));

function openInviteModal() {
  const link = `${location.origin}/party/${code}`;
  $('invite-code').textContent = code;
  $('invite-link').value = link;
  $('localhost-warn').classList.toggle('hidden', !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
  openModal('invite-modal');
  refreshSharing();
}

/** Tell the host whether guests can watch right away, or will have to select the video themselves. */
async function refreshSharing() {
  const box = $('invite-sharing');
  const source = room?.source;
  box.classList.add('hidden');
  if (source?.type !== 'drive' || source.format === 'hls') return;

  const key = sourceKey;
  const shared = await checkLinkShared(source.id);
  if (key !== sourceKey) return;
  $('share-status').textContent = shared
    ? 'Anyone with the link can view this video in Drive, so friends can start watching right away.'
    : 'This video isn\'t shared by link, so each friend needs it shared with their Google account and has to select it once when they join.';
  $('share-enable').classList.toggle('hidden', Boolean(shared));
  $('share-error').textContent = '';
  box.classList.remove('hidden');
}

$('share-enable').addEventListener('click', async () => {
  const button = $('share-enable');
  button.disabled = true;
  try {
    await enableLinkSharing(room.source.id);
    await refreshSharing();
  } catch (err) {
    $('share-error').textContent = err.message;
  } finally {
    button.disabled = false;
  }
});

$('invite-btn').addEventListener('click', openInviteModal);
$('copy-link').addEventListener('click', async () => {
  await copyText($('invite-link').value);
  toast('Invite link copied');
});
$('invite-code').addEventListener('click', async () => {
  await copyText(code);
  toast('Code copied');
});

function openChangeModal() {
  $('change-error').textContent = '';
  $('change-link').value = '';
  openModal('change-modal');
  $('change-link').focus();
}

$('change-btn').addEventListener('click', openChangeModal);
function switchVideo(source) {
  socket.emit('source', source, (res) => {
    if (res?.error) $('change-error').textContent = res.error;
    else closeModals();
  });
}

$('change-pick').addEventListener('click', async () => {
  $('change-error').textContent = '';
  try {
    const picked = await pickDriveVideo();
    if (picked) switchVideo({ type: 'drive', id: picked.id, format: picked.isHls ? 'hls' : 'file', title: picked.name });
  } catch (err) {
    $('change-error').textContent = err.status === 401 ? 'Sign in with Google first.' : err.message;
  }
});

$('change-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('change-submit');
  const source = parseSource($('change-link').value);
  if (!source || source.error) {
    $('change-error').textContent = source?.error || 'Paste a Google Drive video link.';
    return;
  }
  if (source.type === 'url') return switchVideo({ ...(await detectUrlFormat(source)), title: urlTitle(source.url) });

  submit.disabled = true;
  submit.textContent = 'Checking…';
  try {
    const access = await openDriveFile(source.id);
    if (!access.ok) throw new Error(accessMessage(access.reason));
    switchVideo({ ...source, format: access.isHls ? 'hls' : 'file', title: access.name });
  } catch (err) {
    $('change-error').textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Switch video';
  }
});

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

const MAX_SUBTITLE_CHARS = 700_000;
const MAX_SUBTITLE_DELAY = 600;
const SUBTITLE_DELAY_STEP = 0.5;
let subtitleTrack = null; // the <track> showing the party's subtitles
let showSubtitles = true; // this viewer's own choice

/** Make the player's subtitle track match the party's shared subtitles. */
function applySubtitles() {
  if (subtitleTrack) {
    URL.revokeObjectURL(subtitleTrack.src);
    subtitleTrack.remove();
    subtitleTrack = null;
  }
  const subtitles = room?.subtitles;
  if (subtitles) {
    subtitleTrack = el('track', {
      kind: 'subtitles',
      label: subtitles.name,
      src: URL.createObjectURL(new Blob([subtitles.vtt], { type: 'text/vtt' })),
    });
    subtitleTrack.addEventListener('load', applySubtitleDelay);
    video.append(subtitleTrack);
    subtitleTrack.track.mode = showSubtitles ? 'showing' : 'hidden';
  }
  showSubtitleDelay();
  $('subs-current').classList.toggle('hidden', !subtitles);
  $('subs-name').textContent = subtitles ? `Now showing: ${subtitles.name}` : '';
  $('subs-btn').classList.toggle('active', Boolean(subtitles));
}

const originalCueTimes = new WeakMap(); // cue -> [start, end] as written in the file

/** Shift every cue by the party's subtitle delay (positive: captions appear later). */
function applySubtitleDelay() {
  const delay = room?.subtitles?.delay || 0;
  for (const cue of subtitleTrack?.track.cues || []) {
    if (!originalCueTimes.has(cue)) originalCueTimes.set(cue, [cue.startTime, cue.endTime]);
    const [start, end] = originalCueTimes.get(cue);
    cue.endTime = Math.max(cue.endTime, end + delay); // keeps start < end whichever way the cue moves
    cue.startTime = Math.max(0, start + delay);
    cue.endTime = Math.max(0, end + delay);
  }
}

function showSubtitleDelay() {
  const delay = room?.subtitles?.delay || 0;
  $('subs-delay-range').value = delay;
  if (document.activeElement !== $('subs-delay')) $('subs-delay').value = delay;
}

function setSubtitleDelay(value) {
  if (!room?.subtitles || !Number.isFinite(value)) return;
  const delay = Math.max(-MAX_SUBTITLE_DELAY, Math.min(MAX_SUBTITLE_DELAY, Math.round(value * 10) / 10));
  room.subtitles.delay = delay;
  applySubtitleDelay();
  showSubtitleDelay();
  socket.emit('subtitle-delay', delay);
}

$('subs-delay-range').addEventListener('input', (event) => setSubtitleDelay(event.target.valueAsNumber));
$('subs-delay').addEventListener('input', (event) => setSubtitleDelay(event.target.valueAsNumber));
$('subs-delay').addEventListener('blur', showSubtitleDelay);
$('subs-earlier').addEventListener('click', () => setSubtitleDelay(room.subtitles.delay - SUBTITLE_DELAY_STEP));
$('subs-later').addEventListener('click', () => setSubtitleDelay(room.subtitles.delay + SUBTITLE_DELAY_STEP));

function shareSubtitles(name, bytes) {
  const vtt = subtitlesToVtt(bytes);
  if (!vtt) throw new Error('That doesn\'t look like an .srt or .vtt subtitle file.');
  if (vtt.length > MAX_SUBTITLE_CHARS) throw new Error('That subtitle file is too big.');
  socket.emit('subtitles', { name, vtt }, (res) => {
    if (res?.error) $('subs-error').textContent = res.error;
  });
}

$('subs-btn').addEventListener('click', () => {
  $('subs-error').textContent = '';
  openModal('subs-modal');
});

$('subs-pick').addEventListener('click', async () => {
  $('subs-error').textContent = '';
  try {
    const picked = await pickDriveSubtitles();
    if (picked) shareSubtitles(picked.name, picked.bytes);
  } catch (err) {
    $('subs-error').textContent = err.status === 401 ? 'Sign in with Google first, or upload the file from this device.' : err.message;
  }
});

$('subs-upload').addEventListener('click', () => $('subs-file').click());
$('subs-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  $('subs-error').textContent = '';
  try {
    if (file.size > 2_000_000) throw new Error('That file is too big to be subtitles.');
    shareSubtitles(file.name, await file.arrayBuffer());
  } catch (err) {
    $('subs-error').textContent = err.message;
  }
});

$('subs-show').addEventListener('change', (event) => {
  showSubtitles = event.target.checked;
  if (subtitleTrack) subtitleTrack.track.mode = showSubtitles ? 'showing' : 'hidden';
});

$('subs-remove').addEventListener('click', () => socket.emit('subtitles', null, () => {}));

function toggleFullscreen() {
  if (document.fullscreenElement) return document.exitFullscreen();
  if (document.documentElement.requestFullscreen) return document.documentElement.requestFullscreen();
  video.webkitEnterFullscreen?.(); // iOS Safari only supports fullscreen on the video itself
}

$('fullscreen-btn').addEventListener('click', toggleFullscreen);
video.addEventListener('dblclick', toggleFullscreen);

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModals();
  const typing = event.target.closest?.('input, textarea, [contenteditable]');
  if (typing || event.metaKey || event.ctrlKey || event.altKey || !room) return;
  if (!$('join-modal').classList.contains('hidden')) return;

  const key = event.key.toLowerCase();
  if (key === 'c') setChatOpen(!chatIsOpen());
  else if (key === 'f') toggleFullscreen();
  else if (document.activeElement === video) return; // the native player handles its own keys
  else if (key === ' ' || key === 'k') video.paused ? video.play() : video.pause();
  else if (key === 'arrowleft') video.currentTime = Math.max(0, video.currentTime - 10);
  else if (key === 'arrowright') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
  else return;
  event.preventDefault();
});

// ---------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------

async function prepareJoin() {
  $('join-name').value = savedName();
  const res = await fetch(`/api/parties/${encodeURIComponent(code)}`).catch(() => null);
  if (!res?.ok) {
    $('join-heading').textContent = 'Party not found';
    $('join-sub').textContent = 'This party doesn\'t exist or has ended. Ask for a fresh invite.';
    $('join-name').closest('.field').classList.add('hidden');
    const submit = $('join-submit');
    submit.textContent = 'Back to home';
    submit.type = 'button';
    submit.addEventListener('click', () => { location.href = '/'; });
    return;
  }
  const info = await res.json();
  $('join-sub').textContent = `“${info.title || 'Untitled video'}” · ${info.users} watching now`;
  // Returning users skip the prompt; if the browser then blocks autoplay, the "Start watching" overlay covers it.
  if (savedName()) $('join-form').requestSubmit();
  else $('join-name').focus();
}

$('join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if ($('join-submit').type === 'button') return;
  myName = $('join-name').value.trim();
  if (!myName) {
    $('join-error').textContent = 'Enter a name so people know who you are.';
    $('join-name').focus();
    return;
  }
  saveName(myName);
  $('join-error').textContent = '';
  $('join-submit').disabled = true;
  $('join-submit').textContent = 'Joining…';
  socket.connect();
});

initGoogle();
prepareJoin();
