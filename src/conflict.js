/**
 * src/conflict.js
 *
 * Renderer for conflict resolution window.
 */

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const rounded = idx === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${units[idx]}`;
}

function formatDate(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try {
    return new Date(n).toLocaleString();
  } catch {
    return '—';
  }
}

function setKv(container, rows) {
  container.textContent = '';
  for (const [k, v] of rows) {
    const dk = document.createElement('div');
    dk.textContent = k;
    const dv = document.createElement('div');
    dv.textContent = v;
    container.appendChild(dk);
    container.appendChild(dv);
  }
}

function badge(el, text) {
  el.textContent = '';
  if (!text) return;
  const strong = document.createElement('strong');
  strong.textContent = text;
  el.appendChild(strong);
}

function getId() {
  const url = new URL(window.location.href);
  return url.searchParams.get('id') || '';
}

function getApplyToAll() {
  const el = document.getElementById('applyToAll');
  return Boolean(el && el.checked);
}

function configureButtons(kind) {
  const btnCancel = document.getElementById('btnCancel');
  const btnA = document.getElementById('btnA');
  const btnB = document.getElementById('btnB');
  const btnC = document.getElementById('btnC');

  const presets = {
    'both-changed': {
      hint: 'This file was modified both locally and in the cloud. Choose which version to keep.',
      buttons: [
        { el: btnA, label: 'Keep local', decision: 'prefer-local', cls: '' },
        { el: btnB, label: 'Keep cloud', decision: 'prefer-remote', cls: '' },
        { el: btnC, label: 'Keep both', decision: 'keep-both', cls: 'primary' },
      ],
    },
    'remote-deleted-local-changed': {
      hint: 'The cloud version was deleted, but the local version was modified. Choose what to do.',
      buttons: [
        { el: btnA, label: 'Restore to cloud', decision: 'prefer-local', cls: 'primary' },
        { el: btnB, label: 'Remove local copy', decision: 'delete-local', cls: 'danger' },
        { el: btnC, label: '', decision: '', cls: 'hidden' },
      ],
    },
    'local-deleted-remote-changed': {
      hint: 'The local version was deleted, but the cloud version was modified. Choose what to do.',
      buttons: [
        { el: btnA, label: 'Restore locally', decision: 'prefer-remote', cls: 'primary' },
        { el: btnB, label: 'Delete cloud copy', decision: 'delete-remote', cls: 'danger' },
        { el: btnC, label: '', decision: '', cls: 'hidden' },
      ],
    },
  };

  const preset = presets[kind] || presets['both-changed'];
  document.getElementById('conflictHint').textContent = preset.hint;

  const all = [btnA, btnB, btnC];
  for (const btn of all) {
    btn.style.display = '';
    btn.classList.remove('primary', 'danger');
    btn.disabled = false;
  }

  for (const btn of all) btn.style.display = 'none';

  for (const { el, label, decision, cls } of preset.buttons) {
    if (!label) {
      el.style.display = 'none';
      continue;
    }
    el.style.display = '';
    el.textContent = label;
    el.onclick = async () => {
      el.disabled = true;
      try {
        await window.conflictDialog.choose(getId(), decision, { applyToAll: getApplyToAll() });
      } catch {
        // Best-effort.
      }
    };
    if (cls === 'primary') el.classList.add('primary');
    if (cls === 'danger') el.classList.add('danger');
  }

  btnCancel.onclick = async () => {
    try {
      await window.conflictDialog.choose(getId(), 'skip', { applyToAll: false });
    } catch {
      // Best-effort.
    }
  };
}

function configureOpenButtons(payload) {
  const id = getId();
  const btnOpenLocal = document.getElementById('btnOpenLocal');
  const btnOpenRemote = document.getElementById('btnOpenRemote');
  const btnOpenBoth = document.getElementById('btnOpenBoth');

  const localAvailable = Boolean(payload?.local?.exists);
  const remoteAvailable = Boolean(payload?.remote?.exists);

  btnOpenLocal.disabled = !localAvailable;
  btnOpenRemote.disabled = !remoteAvailable;
  btnOpenBoth.disabled = !(localAvailable || remoteAvailable);

  btnOpenLocal.onclick = async () => {
    btnOpenLocal.disabled = true;
    try { await window.conflictDialog.openLocal(id); } catch {}
    btnOpenLocal.disabled = !localAvailable;
  };

  btnOpenRemote.onclick = async () => {
    btnOpenRemote.disabled = true;
    try { await window.conflictDialog.openRemote(id); } catch {}
    btnOpenRemote.disabled = !remoteAvailable;
  };

  btnOpenBoth.onclick = async () => {
    btnOpenBoth.disabled = true;
    try { await window.conflictDialog.openBoth(id); } catch {}
    btnOpenBoth.disabled = !(localAvailable || remoteAvailable);
  };
}

async function main() {
  const id = getId();
  const subtitle = document.getElementById('conflictSubtitle');
  if (!id) {
    subtitle.textContent = 'Missing conflict id';
    return;
  }

  const payload = await window.conflictDialog.get(id);
  if (!payload) {
    subtitle.textContent = 'Conflict data not found';
    return;
  }

  subtitle.textContent = payload.relativePath || '—';
  configureButtons(payload.kind || 'both-changed');
  configureOpenButtons(payload);

  const localMeta = document.getElementById('localMeta');
  const remoteMeta = document.getElementById('remoteMeta');
  const localBadgeEl = document.getElementById('localBadge');
  const remoteBadgeEl = document.getElementById('remoteBadge');

  if (payload.local?.exists) {
    badge(localBadgeEl, 'Present');
    const s = payload.local.state || {};
    setKv(localMeta, [
      ['Size', formatBytes(s.size)],
      ['Created', formatDate(s.birthtimeMs || s.createdAtMs)],
      ['Modified', formatDate(s.mtimeMs)],
      ['SHA-1', s.sha1 || '—'],
    ]);
  } else {
    badge(localBadgeEl, 'Deleted');
    const prev = payload.local?.previous || {};
    setKv(localMeta, [
      ['Previous size', formatBytes(prev.size)],
      ['Previous modified', formatDate(prev.mtimeMs)],
      ['Previous SHA-1', prev.sha1 || '—'],
    ]);
  }

  if (payload.remote?.exists) {
    badge(remoteBadgeEl, 'Present');
    const s = payload.remote.state || {};
    setKv(remoteMeta, [
      ['Size', formatBytes(s.size)],
      ['Created', formatDate(s.createdAtMs)],
      ['Modified', formatDate(s.updatedAtMs)],
      ['SHA-1', s.sha1 || '—'],
    ]);
  } else {
    badge(remoteBadgeEl, 'Deleted');
    const prev = payload.remote?.previous || {};
    setKv(remoteMeta, [
      ['Previous size', formatBytes(prev.size)],
      ['Previous modified', formatDate(prev.updatedAtMs)],
      ['Previous SHA-1', prev.sha1 || '—'],
    ]);
  }
}

main().catch(() => {});
