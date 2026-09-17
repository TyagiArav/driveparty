import { parseSource, inspectSource, extractCode, savedName, saveName } from './common.js';

const createForm = document.getElementById('create-form');
const createLink = document.getElementById('create-link');
const createName = document.getElementById('create-name');
const createError = document.getElementById('create-error');
const createBtn = document.getElementById('create-btn');
const joinForm = document.getElementById('join-form');
const joinCode = document.getElementById('join-code');
const joinError = document.getElementById('join-error');

createName.value = savedName();

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  createError.textContent = '';

  const source = parseSource(createLink.value);
  if (!source || source.error) {
    createError.textContent = source?.error || 'Paste a Google Drive video link.';
    createLink.focus();
    return;
  }

  createBtn.disabled = true;
  createBtn.textContent = 'Checking video…';
  try {
    const info = await inspectSource(source);
    if (!info.ok) throw new Error(info.error);
    source.title = info.title;

    createBtn.textContent = 'Creating party…';
    const res = await fetch('/api/parties', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create the party.');

    if (createName.value.trim()) saveName(createName.value.trim());
    location.href = `/party/${data.code}?invite=1`;
  } catch (err) {
    createError.textContent = err.message || 'Something went wrong.';
    createBtn.disabled = false;
    createBtn.textContent = 'Create party';
  }
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  joinError.textContent = '';
  const code = extractCode(joinCode.value);
  if (!code) {
    joinError.textContent = 'Enter the party code or paste the invite link.';
    return;
  }
  const res = await fetch(`/api/parties/${code}`);
  if (!res.ok) {
    joinError.textContent = 'No party with that code. It may have ended.';
    return;
  }
  location.href = `/party/${code}`;
});
