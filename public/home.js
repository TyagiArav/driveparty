import { parseSource, detectUrlFormat, urlTitle, extractCode, savedName, saveName, toast } from './common.js';
import {
  initGoogle, getMe, signIn, signOut, pickDriveVideo, openDriveFile, accessMessage, NeedsConsentError,
} from './google.js';

const $ = (id) => document.getElementById(id);
const createError = $('create-error');
const createName = $('create-name');
const signInBtn = $('sign-in-btn');

let me = null;
let needsConsent = false;

async function render() {
  const [config, account] = await Promise.all([initGoogle(), getMe()]);
  me = account;
  $('setup-missing').classList.toggle('hidden', config.configured);
  $('signed-out').classList.toggle('hidden', !config.configured || me.signedIn);
  $('create-form').classList.toggle('hidden', !config.configured || !me.signedIn);
  if (me.signedIn) {
    $('account-email').textContent = me.email;
    if (me.picture) $('account-picture').src = me.picture;
    if (!createName.value) createName.value = savedName() || me.name || '';
  }
}

signInBtn.addEventListener('click', async () => {
  signInBtn.disabled = true;
  try {
    await signIn({ consent: needsConsent });
    needsConsent = false;
    await render();
  } catch (err) {
    needsConsent = err instanceof NeedsConsentError;
    signInBtn.querySelector('svg').nextSibling.textContent = needsConsent ? ' Finish signing in' : ' Sign in with Google';
    toast(err.message);
  } finally {
    signInBtn.disabled = false;
  }
});

$('sign-out-btn').addEventListener('click', async () => {
  await signOut();
  await render();
});

function setBusy(busy, label) {
  $('pick-btn').disabled = busy;
  $('create-btn').disabled = busy;
  $('create-btn').textContent = busy ? label : 'Create';
}

async function createParty(source) {
  const res = await fetch('/api/parties', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not create the party.');
  if (createName.value.trim()) saveName(createName.value.trim());
  location.href = `/party/${data.code}?invite=1`;
}

$('pick-btn').addEventListener('click', async () => {
  createError.textContent = '';
  setBusy(true, '…');
  try {
    const picked = await pickDriveVideo();
    if (!picked) return;
    await createParty({ type: 'drive', id: picked.id, format: picked.isHls ? 'hls' : 'file', title: picked.name });
  } catch (err) {
    createError.textContent = err.message || 'Something went wrong.';
  } finally {
    setBusy(false);
  }
});

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  createError.textContent = '';
  let source = parseSource($('create-link').value);
  if (!source || source.error) {
    createError.textContent = source?.error || 'Paste a Google Drive video link.';
    return;
  }

  setBusy(true, 'Checking…');
  try {
    if (source.type === 'drive') {
      const access = await openDriveFile(source.id);
      if (!access.ok) throw new Error(accessMessage(access.reason, me?.email));
      source.title = access.name;
      source.format = access.isHls ? 'hls' : 'file';
    } else {
      source = { ...(await detectUrlFormat(source)), title: urlTitle(source.url) };
    }
    await createParty(source);
  } catch (err) {
    createError.textContent = err.message || 'Something went wrong.';
  } finally {
    setBusy(false);
  }
});

$('join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('join-error').textContent = '';
  const code = extractCode($('join-code').value);
  if (!code) {
    $('join-error').textContent = 'Enter the party code or paste the invite link.';
    return;
  }
  const res = await fetch(`/api/parties/${code}`);
  if (!res.ok) {
    $('join-error').textContent = 'No party with that code. It may have ended.';
    return;
  }
  location.href = `/party/${code}`;
});

render();
