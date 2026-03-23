/**
 * src/renderer.js
 *
 * Nextcloud-inspired UI shell with stable state management.
 * Renderer talks to Electron main via preload `window.desktopSync`.
 */
// BOOT_MARKER: visible hint that renderer JS executed.
try {
  const h = document.getElementById('statusHeadline');
  const t = document.getElementById('statusText');
  if (h && t) {
    h.textContent = 'Booting…';
    t.textContent = 'Starting UI…';
  }
} catch { /* no-op */ }


function sanitizeConfigForMain(config) {
  if (!config) return {};
  const { serverHost, tokenMasked, isLoggedIn, ...rest } = config;
  return rest;
}



const els = Object.freeze({
  accountMenuButton: document.getElementById('accountMenuButton'),
  accountMenu: document.getElementById('accountMenu'),
  accountAvatar: document.getElementById('accountAvatar'),
  accountDisplayName: document.getElementById('accountDisplayName'),
  accountServer: document.getElementById('accountServer'),

  menuSettings: document.getElementById('menuSettings'),
  menuAddAccount: document.getElementById('menuAddAccount'),
  menuExit: document.getElementById('menuExit'),

  openLocalFolderButton: document.getElementById('openLocalFolderButton'),
  openSettingsButton: document.getElementById('openSettingsButton'),

  statusDot: document.getElementById('statusDot'),
  statusHeadline: document.getElementById('statusHeadline'),
  statusText: document.getElementById('statusText'),
  lastSyncTime: document.getElementById('lastSyncTime'),
  lastRemoteFolder: document.getElementById('lastRemoteFolder'),
  syncNowButton: document.getElementById('syncNowButton'),
  pauseSyncButton: document.getElementById('pauseSyncButton'),

  activityList: document.getElementById('activityList'),
  clearActivityButton: document.getElementById('clearActivityButton'),
  transferSummary: document.getElementById('transferSummary'),
  transferCounts: document.getElementById('transferCounts'),
  pendingOpsLabel: document.getElementById('pendingOpsLabel'),
  transferList: document.getElementById('transferList'),

  settingsModal: document.getElementById('settingsModal'),
  settingsCloseButton: document.getElementById('settingsCloseButton'),
  settingsAvatar: document.getElementById('settingsAvatar'),
  settingsName: document.getElementById('settingsName'),
  settingsServer: document.getElementById('settingsServer'),
  connectionStatusText: document.getElementById('connectionStatusText'),
  storageUsed: document.getElementById('storageUsed'),

  tabButtons: Array.from(document.querySelectorAll('.tab-button[data-tab]')),
  tabPanels: {
    sync: document.getElementById('tab-sync'),
    account: document.getElementById('tab-account'),
    general: document.getElementById('tab-general'),
    trash: document.getElementById('tab-trash'),
  },

  // Sync tab controls
  localFolder: document.getElementById('localFolder'),
  pickLocalFolderButton: document.getElementById('pickLocalFolderButton'),

  remoteFolderTrigger: document.getElementById('remoteFolderTrigger'),
  remoteFolderMenu: document.getElementById('remoteFolderMenu'),
  remoteFolderSummary: document.getElementById('remoteFolderSummary'),
  refreshRemoteFoldersButton: document.getElementById('refreshRemoteFoldersButton'),
  browseRemoteFoldersButton: document.getElementById('browseRemoteFoldersButton'),

  enableDownloadSync: document.getElementById('enableDownloadSync'),
  enableUploadSync: document.getElementById('enableUploadSync'),
  autoSyncEnabled: document.getElementById('autoSyncEnabled'),
  wifiOnly: document.getElementById('wifiOnly'),
  cloudFilesPanel: document.getElementById('cloudFilesPanel'),
  virtualFilesEnabled: document.getElementById('virtualFilesEnabled'),
  virtualFilesFolder: document.getElementById('virtualFilesFolder'),
  virtualFilesFolderUnlocked: document.getElementById('virtualFilesFolderUnlocked'),
  pickVirtualFilesFolderButton: document.getElementById('pickVirtualFilesFolderButton'),
  openVirtualFilesFolderButton: document.getElementById('openVirtualFilesFolderButton'),
  vfsProviderStatusText: document.getElementById('vfsProviderStatusText'),
  selectiveSyncSummary: document.getElementById('selectiveSyncSummary'),
  openSelectiveSyncButton: document.getElementById('openSelectiveSyncButton'),
  clearSelectiveSyncButton: document.getElementById('clearSelectiveSyncButton'),
  ignoreRulesText: document.getElementById('ignoreRulesText'),
  ignoreInsertPresetsButton: document.getElementById('ignoreInsertPresetsButton'),
  ignoreClearButton: document.getElementById('ignoreClearButton'),
  pollIntervalSeconds: document.getElementById('pollIntervalSeconds'),
  syncConcurrency: document.getElementById('syncConcurrency'),
  conflictStrategy: document.getElementById('conflictStrategy'),
  moveLocalDeletesToTrash: document.getElementById('moveLocalDeletesToTrash'),

  explorerShortcutName: document.getElementById('explorerShortcutName'),
  autoCreateExplorerShortcut: document.getElementById('autoCreateExplorerShortcut'),
  createShortcutButton: document.getElementById('createShortcutButton'),
  removeShortcutButton: document.getElementById('removeShortcutButton'),
  shortcutStatus: document.getElementById('shortcutStatus'),

  debugApi: document.getElementById('debugApi'),
  clearApiLogButton: document.getElementById('clearApiLogButton'),
  apiDebugLog: document.getElementById('apiDebugLog'),

  // Account tab controls
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  rememberPassword: document.getElementById('rememberPassword'),
  loginButton: document.getElementById('loginButton'),
  logoutButton: document.getElementById('logoutButton'),
  tokenMasked: document.getElementById('tokenMasked'),
  manualToken: document.getElementById('manualToken'),
  useTokenButton: document.getElementById('useTokenButton'),
  accountError: document.getElementById('accountError'),

  // General tab controls
  launchOnStartup: document.getElementById('launchOnStartup'),
  showNotifications: document.getElementById('showNotifications'),
  cacheAutoClean: document.getElementById('cacheAutoClean'),
  cacheMaxAgeDays: document.getElementById('cacheMaxAgeDays'),
  cacheMaxSizeMb: document.getElementById('cacheMaxSizeMb'),
  openCacheFolderButton: document.getElementById('openCacheFolderButton'),
  runCacheCleanupButton: document.getElementById('runCacheCleanupButton'),
  cacheInfoText: document.getElementById('cacheInfoText'),
  apiSelfTestButton: document.getElementById('apiSelfTestButton'),
  apiSelfTestOutput: document.getElementById('apiSelfTestOutput'),

  // Wizard
  wizardModal: document.getElementById('wizardModal'),
  wizardEmail: document.getElementById('wizardEmail'),
  wizardPassword: document.getElementById('wizardPassword'),
  wizardRememberPassword: document.getElementById('wizardRememberPassword'),
  wizardToken: document.getElementById('wizardToken'),
  wizardUseTokenButton: document.getElementById('wizardUseTokenButton'),
  wizardLoginButton: document.getElementById('wizardLoginButton'),
  wizardError: document.getElementById('wizardError'),


// Folder browser
folderBrowserModal: document.getElementById('folderBrowserModal'),
folderBrowserCloseButton: document.getElementById('folderBrowserCloseButton'),
folderBrowserCancelButton: document.getElementById('folderBrowserCancelButton'),
folderBrowserSelectButton: document.getElementById('folderBrowserSelectButton'),
folderBreadcrumb: document.getElementById('folderBreadcrumb'),
folderBrowserList: document.getElementById('folderBrowserList'),
folderBrowserLoading: document.getElementById('folderBrowserLoading'),
folderBrowserError: document.getElementById('folderBrowserError'),
folderBrowserNewName: document.getElementById('folderBrowserNewName'),
folderBrowserCreateButton: document.getElementById('folderBrowserCreateButton'),
folderBrowserCreateStatus: document.getElementById('folderBrowserCreateStatus'),

// Trash
trashCount: document.getElementById('trashCount'),
trashRefreshButton: document.getElementById('trashRefreshButton'),
trashRestoreButton: document.getElementById('trashRestoreButton'),
trashDeleteButton: document.getElementById('trashDeleteButton'),
trashEmptyButton: document.getElementById('trashEmptyButton'),

// Selective Sync modal
selectiveSyncModal: document.getElementById('selectiveSyncModal'),
selectiveSyncCloseButton: document.getElementById('selectiveSyncCloseButton'),
selectiveSyncCancelButton: document.getElementById('selectiveSyncCancelButton'),
selectiveSyncSaveButton: document.getElementById('selectiveSyncSaveButton'),
selectiveSyncSearch: document.getElementById('selectiveSyncSearch'),
selectiveSyncSelectAllButton: document.getElementById('selectiveSyncSelectAllButton'),
selectiveSyncSelectNoneButton: document.getElementById('selectiveSyncSelectNoneButton'),
selectiveSyncList: document.getElementById('selectiveSyncList'),
selectiveSyncLoading: document.getElementById('selectiveSyncLoading'),
selectiveSyncError: document.getElementById('selectiveSyncError'),
trashSearch: document.getElementById('trashSearch'),
trashLoading: document.getElementById('trashLoading'),
trashError: document.getElementById('trashError'),
trashListBody: document.getElementById('trashListBody'),
});

function assertElements() {
  const missing = Object.entries(els)
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  if (missing.length) {
    // eslint-disable-next-line no-console
    console.error('Missing DOM elements:', missing);
  }
}

const state = {
  config: null,
  ui: {
    settingsOpen: false,
    settingsTab: 'sync',
    accountMenuOpen: false,
    remoteDropdownOpen: false,
    apiLog: [],
    activity: [],
    isWindows: /Windows/i.test(navigator.userAgent),
    liveSync: { ts: '', completed: 0, total: 0, live: { uploading: 0, downloading: 0, conflicts: 0 }, active: [], pendingOpsCount: 0 },
    cacheInfo: { root: '', sizeBytes: 0, fileCount: 0 },
  },
  remoteFolders: {
    loading: false,
    items: [],
    error: '',
  },
  trash: {
    loading: false,
    error: '',
    query: '',
    items: [],
    selected: new Set(),
  },

  selectiveSync: {
    open: false,
    loading: false,
    error: '',
    query: '',
    folderPaths: [],
    excluded: new Set(),
  },


folderBrowser: {
  open: false,
  loading: false,
  error: '',
  createStatus: '',
  createStatusKind: 'muted',

  breadcrumb: [{ id: '__root__', name: 'Root' }],
  items: [],
},
  status: {
    headline: 'Loading…',
    text: 'Initializing…',
    lastSync: '—',
    remoteFolderName: '—',
    kind: 'idle', // idle | ok | busy | warn | error
  },
};

function normalizeBaseUrl(url) {
  const raw = (url || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function isAuthenticated(config) {
  return Boolean(config && (config.isLoggedIn || (config.token && String(config.token).trim())));
}

function maskToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length <= 10) return '••••••••••';
  return `${t.slice(0, 4)}••••••••••${t.slice(-4)}`;
}


function formatRemoteFolderPathLabel(folder) {
  if (!folder) return '—';
  const id = String(folder.id ?? '').trim();
  if (id === '__root__') return '/';

  const cfg = state.config || {};
  const cfgId = cfg.remoteFolderId ? String(cfg.remoteFolderId).trim() : '';
  if (cfgId && cfgId === id && cfg.remoteFolderPathLabel) {
    return String(cfg.remoteFolderPathLabel);
  }

  const rawName = String(folder.displayLabel || folder.name || folder.path || '').trim();
  if (!rawName) return '—';
  if (rawName.startsWith('/')) return rawName;
  return `/${rawName}`;
}

function setModalOpen(modalEl, open) {
  modalEl.dataset.open = open ? 'true' : 'false';
  modalEl.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function setStatusKind(kind) {
  state.status.kind = kind;
  const map = {
    idle: 'rgba(255,255,255,0.35)',
    ok: 'rgba(70, 200, 120, 0.9)',
    busy: 'rgba(13, 116, 185, 0.9)',
    warn: 'rgba(255, 200, 80, 0.9)',
    error: 'rgba(255, 107, 107, 0.9)',
  };
  els.statusDot.style.background = map[kind] || map.idle;
}

function setAccountError(text) {
  if (!text) {
    els.accountError.hidden = true;
    els.accountError.textContent = '';
    return;
  }
  els.accountError.hidden = false;
  els.accountError.textContent = text;
}

function setWizardError(text) {
  if (!text) {
    els.wizardError.hidden = true;
    els.wizardError.textContent = '';
    return;
  }
  els.wizardError.hidden = false;
  els.wizardError.textContent = text;
}

function pushApiLogLine(line) {
  const ts = new Date().toISOString();
  const safe = String(line || '')
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9|._-]+/gi, 'Authorization: Bearer <masked>')
    .replace(/"Authorization"\s*:\s*"Bearer\s+[^"]+"/gi, '"Authorization":"Bearer <masked>"');

  state.ui.apiLog.push(`[${ts}] ${safe}`);
  if (state.ui.apiLog.length > 500) {
    state.ui.apiLog.splice(0, state.ui.apiLog.length - 500);
  }

  if (state.config?.debugApi) {
    els.apiDebugLog.textContent = state.ui.apiLog.slice(-350).join('\n');
    els.apiDebugLog.scrollTop = els.apiDebugLog.scrollHeight;
  }
}

function applyEnvelope(envelope) {
  if (!envelope) return;
  if (envelope.config) state.config = envelope.config;

  if (Array.isArray(envelope.activityLog)) {
    state.ui.activity = envelope.activityLog
      .map(item => ({
        title: item?.message || item?.title || 'Activity',
        subtitle: item?.detail || item?.action || item?.level || '',
        timestamp: item?.at || '',
      }))
      .reverse()
      .slice(-100)
      .reverse();
  }

  if (typeof envelope.status === 'string') {
    state.status.text = envelope.status;
  }

  if (typeof envelope.syncInProgress === 'boolean') {
    state.status.kind = envelope.syncInProgress ? 'busy' : state.status.kind;
  }

  if (envelope.latestSyncResult && state.config?.lastSyncContext?.finishedAt) {
    state.status.lastSync = state.config.lastSyncContext.finishedAt;
  }

  if (state.config?.remoteFolderName) state.status.remoteFolderName = state.config.remoteFolderName;
  if (state.config?.lastSyncContext?.remoteFolderName) state.status.remoteFolderName = state.config.lastSyncContext.remoteFolderName;  state.config.tokenMasked = state.config.tokenMasked || maskToken(state.config.token);
}

let saveTimer = null;

async function refreshCacheInfo() {
  try {
    if (!window.desktopSync?.getCacheInfo) return;
    const info = await window.desktopSync.getCacheInfo();
    if (info) state.ui.cacheInfo = info;
  } catch {
    // Best-effort.
  }
}

function scheduleSaveConfig() {
  if (!state.config) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {      const env = await window.desktopSync.saveConfig(sanitizeConfigForMain(state.config));
      applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
    try { state.ui.vfsStatus = await window.desktopSync.getVfsStatus(); } catch {}

      renderAll();
    } catch (err) {
      pushApiLogLine(`saveConfig failed: ${String(err && err.message ? err.message : err)}`);
    }
  }, 250);
}

function closeAccountMenu() {
  state.ui.accountMenuOpen = false;
  els.accountMenu.hidden = true;
  els.accountMenuButton.setAttribute('aria-expanded', 'false');
}

function openAccountMenu() {
  state.ui.accountMenuOpen = true;
  els.accountMenu.hidden = false;
  els.accountMenuButton.setAttribute('aria-expanded', 'true');
}

function toggleAccountMenu() {
  if (state.ui.accountMenuOpen) closeAccountMenu();
  else openAccountMenu();
}

function closeRemoteDropdown() {
  state.ui.remoteDropdownOpen = false;
  els.remoteFolderMenu.hidden = true;
  els.remoteFolderMenu.style.display = 'none';
  els.remoteFolderTrigger.setAttribute('aria-expanded', 'false');
}

function openRemoteDropdown() {
  if (!state.remoteFolders.items.length) return;
  state.ui.remoteDropdownOpen = true;
  els.remoteFolderMenu.hidden = false;
  els.remoteFolderMenu.style.display = 'block';
  els.remoteFolderTrigger.setAttribute('aria-expanded', 'true');
}

function toggleRemoteDropdown() {
  if (state.ui.remoteDropdownOpen) closeRemoteDropdown();
  else openRemoteDropdown();
}

function openSettingsModal(tab = null) {
  state.ui.settingsOpen = true;
  setModalOpen(els.settingsModal, true);
  if (tab) state.ui.settingsTab = tab;
  switchSettingsTab(state.ui.settingsTab);
  closeAccountMenu();
}

function closeSettingsModal() {
  state.ui.settingsOpen = false;
  setModalOpen(els.settingsModal, false);
}

function showWizardIfNeeded() {
  const needs = !isAuthenticated(state.config);
  setModalOpen(els.wizardModal, needs);
  if (needs) {
    closeSettingsModal();
    closeAccountMenu();
    closeRemoteDropdown();
  }
}

function switchSettingsTab(tab) {
  const next = ['sync', 'account', 'general', 'trash'].includes(tab) ? tab : 'sync';
  state.ui.settingsTab = next;

  for (const btn of els.tabButtons) {
    const active = btn.dataset.tab === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const [name, panel] of Object.entries(els.tabPanels)) {
    panel.classList.toggle('active', name === next);
  }
  if (next === 'trash') {
    loadTrash();
  }
}

function renderAccount() {
  const cfg = state.config || {};
  const name = cfg.user?.name || cfg.user?.email || cfg.email || 'Not signed in';
  const server = (() => {
    const base = cfg.baseUrl || `https://${cfg.serverHost || 'boltbytes.com'}`;
    try {
      return new URL(base).host;
    } catch {
      return base.replace(/^https?:\/\//i, '');
    }
  })();

  const initial = (name || 'B').trim().slice(0, 1).toUpperCase();
  els.accountAvatar.textContent = initial;
  els.accountDisplayName.textContent = name;
  els.accountServer.textContent = server;

  els.settingsAvatar.textContent = initial;
  els.settingsName.textContent = name;
  els.settingsServer.textContent = server;

  els.connectionStatusText.textContent = isAuthenticated(cfg)
    ? `Connected to ${(cfg.serverHost || 'boltbytes.com')} as ${name}.`
    : 'Not connected.';

  els.tokenMasked.value = cfg.tokenMasked || maskToken(cfg.token);
}

function renderPauseButton() {
  if (!els.pauseSyncButton || !state.config) return;
  const paused = Boolean(state.config.syncPaused);
  els.pauseSyncButton.textContent = paused ? 'Resume sync' : 'Pause sync';
}

function renderStatus() {
  els.statusHeadline.textContent = state.status.headline || 'Ready';
  els.statusText.textContent = state.status.text || '';
  els.lastSyncTime.textContent = state.status.lastSync || state.config?.lastSyncContext?.finishedAt || '—';
  els.lastRemoteFolder.textContent = state.status.remoteFolderPathLabel || state.config?.remoteFolderPathLabel || state.status.remoteFolderName || state.config?.remoteFolderName || '—';
  setStatusKind(state.status.kind);

}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u += 1;
  }
  const fixed = n >= 100 || u === 0 ? 0 : (n >= 10 ? 1 : 2);
  return `${n.toFixed(fixed)} ${units[u]}`;
}

function formatAgeShort(ts) {
  if (!ts) return '';
  const t = typeof ts === 'number' ? ts : Date.parse(String(ts));
  if (!Number.isFinite(t)) return '';
  const delta = Math.max(0, Date.now() - t);

  const seconds = Math.round(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.round(delta / 3600000);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.round(delta / 86400000);
  return `${days}d ago`;
}


function renderTransfers() {
  if (!els.transferSummary || !els.transferCounts || !els.transferList || !els.pendingOpsLabel) return;

  const live = state.ui.liveSync || {};
  const counts = live.live || { uploading: 0, downloading: 0, conflicts: 0 };
  const active = Array.isArray(live.active) ? live.active : [];
  const pendingOps = Number(live.pendingOpsCount || 0);

  const hasAnything = active.length > 0 || pendingOps > 0 || Number(counts.conflicts || 0) > 0;
  els.transferSummary.hidden = !hasAnything;

  const uploading = Number(counts.uploading || 0);
  const downloading = Number(counts.downloading || 0);
  const conflicts = Number(counts.conflicts || 0);

  const parts = [];
  if (uploading) parts.push(`${uploading} uploading`);
  if (downloading) parts.push(`${downloading} downloading`);
  if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
  els.transferCounts.textContent = parts.length ? parts.join(' • ') : '—';

  els.pendingOpsLabel.textContent = pendingOps ? `${pendingOps} pending operation${pendingOps === 1 ? '' : 's'}` : '';

  els.transferList.replaceChildren();
  for (const item of active.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = 'transfer-item';

    const name = document.createElement('strong');
    name.textContent = item?.name || item?.path || item?.file || 'Transfer';

    const meta = document.createElement('span');
    const direction = item?.direction || item?.kind || '';
    const done = Number(item?.completedBytes || item?.doneBytes || 0);
    const total = Number(item?.totalBytes || item?.sizeBytes || 0);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const metaParts = [];
    if (direction) metaParts.push(direction);
    if (total > 0) metaParts.push(`${formatBytes(done)} / ${formatBytes(total)} (${pct}%)`);
    else if (done > 0) metaParts.push(formatBytes(done));
    if (item?.status) metaParts.push(String(item.status));

    meta.textContent = metaParts.join(' • ') || '';
    li.append(name, meta);
    els.transferList.appendChild(li);
  }
}

function renderActivity() {
  els.activityList.replaceChildren();
  for (const entry of state.ui.activity.slice(0, 60)) {
    const li = document.createElement('li');
    li.className = 'activity-item';

    const title = document.createElement('strong');
    title.textContent = entry.title || 'Event';

    const meta = document.createElement('span');
    const ts = entry.timestamp ? ` • ${entry.timestamp}` : '';
    meta.textContent = `${entry.subtitle || ''}${ts}`.trim();

    li.appendChild(title);
    li.appendChild(meta);
    els.activityList.appendChild(li);
  }
}

function openSelectiveSyncModal() {
  if (!els.selectiveSyncModal) return;
  state.selectiveSync.open = true;
  state.selectiveSync.error = '';
  state.selectiveSync.query = '';
  state.selectiveSync.excluded = new Set(Array.isArray(state.config?.selectiveSyncExcludedFolders) ? state.config.selectiveSyncExcludedFolders : []);
  els.selectiveSyncModal.setAttribute('aria-hidden', 'false');
  els.selectiveSyncModal.classList.add('open');
  if (els.selectiveSyncSearch) els.selectiveSyncSearch.value = '';
  loadSelectiveSyncFolders().catch(() => {});
  renderSelectiveSync();
}

function closeSelectiveSyncModal() {
  if (!els.selectiveSyncModal) return;
  state.selectiveSync.open = false;
  els.selectiveSyncModal.setAttribute('aria-hidden', 'true');
  els.selectiveSyncModal.classList.remove('open');
}

async function loadSelectiveSyncFolders() {
  if (!state.config) return;
  state.selectiveSync.loading = true;
  state.selectiveSync.error = '';
  renderSelectiveSync();

  try {
    const env = await window.desktopSync.listRemoteFolderTreePaths(state.config);
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
    state.selectiveSync.folderPaths = Array.isArray(env.folderPaths) ? env.folderPaths : [];
  } catch (err) {
    state.selectiveSync.error = String(err?.message || err);
  } finally {
    state.selectiveSync.loading = false;
    renderSelectiveSync();
  }
}

function renderSelectiveSync() {
  if (!els.selectiveSyncList || !els.selectiveSyncLoading || !els.selectiveSyncError) return;
  const query = String(state.selectiveSync.query || '').toLowerCase();
  const folders = Array.isArray(state.selectiveSync.folderPaths) ? state.selectiveSync.folderPaths : [];

  els.selectiveSyncLoading.hidden = !state.selectiveSync.loading;
  if (state.selectiveSync.error) {
    els.selectiveSyncError.hidden = false;
    els.selectiveSyncError.textContent = state.selectiveSync.error;
  } else {
    els.selectiveSyncError.hidden = true;
    els.selectiveSyncError.textContent = '';
  }

  els.selectiveSyncList.innerHTML = '';
  const filtered = query
    ? folders.filter(p => p.toLowerCase().includes(query))
    : folders;

  for (const folderPath of filtered) {
    const row = document.createElement('label');
    const depth = Math.min(4, folderPath.split('/').filter(Boolean).length - 1);
    row.className = `selective-sync-row selective-sync-indent-${depth}`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !state.selectiveSync.excluded.has(folderPath);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selectiveSync.excluded.delete(folderPath);
      else state.selectiveSync.excluded.add(folderPath);
      renderSelectiveSyncSummary();
    });
    const name = document.createElement('span');
    name.className = 'selective-sync-path';
    name.textContent = folderPath;
    row.append(checkbox, name);
    els.selectiveSyncList.appendChild(row);
  }
  renderSelectiveSyncSummary();
}

function renderSelectiveSyncSummary() {
  if (!els.selectiveSyncSummary) return;
  const excluded = Array.isArray(state.config?.selectiveSyncExcludedFolders) ? state.config.selectiveSyncExcludedFolders : [];
  const count = excluded.length;
  els.selectiveSyncSummary.textContent = count ? `Excluded folders: ${count}` : 'Syncing all folders.';
}

function renderForms() {
  const cfg = state.config || {};
  const isWin = Boolean(state.ui.isWindows);
  els.email.value = cfg.email || '';
  els.password.value = cfg.password || '';
  els.rememberPassword.checked = Boolean(cfg.rememberPassword);

  els.localFolder.value = cfg.localFolder || '';
  els.enableDownloadSync.checked = Boolean(cfg.enableDownloadSync);
  if (els.enableUploadSync) els.enableUploadSync.checked = cfg.enableUploadSync !== false;
  els.autoSyncEnabled.checked = Boolean(cfg.autoSyncEnabled);

  els.pollIntervalSeconds.value = String(cfg.pollIntervalSeconds ?? 30);
  els.syncConcurrency.value = String(cfg.syncConcurrency ?? 3);
  els.conflictStrategy.value = cfg.conflictStrategy || 'ask';
  els.moveLocalDeletesToTrash.checked = cfg.moveLocalDeletesToTrash !== false;

  if (els.cloudFilesPanel) {
    els.cloudFilesPanel.classList.toggle('disabled', !isWin);
    els.cloudFilesPanel.querySelectorAll('input,button').forEach(el => { el.disabled = !isWin; });
  }
  if (els.virtualFilesEnabled) els.virtualFilesEnabled.checked = Boolean(cfg.virtualFilesEnabled);
  if (els.virtualFilesFolder) els.virtualFilesFolder.value = cfg.virtualFilesFolder || '';

  if (els.vfsProviderStatusText) {
    const vfs = state.ui.vfsStatus || {};
    const provider = vfs.provider || {};
    let text = 'Disabled';
    if (!isWin) {
      text = 'Unavailable on this platform';
    } else if (!cfg.virtualFilesEnabled) {
      text = 'Disabled';
    } else if (!cfg.remoteFolderId) {
      text = 'Waiting: select a cloud folder first';
    } else if (provider.running) {
      text = 'Running';
    } else if (provider.lastError) {
      text = `Not running: ${provider.lastError}`;
    } else {
      text = 'Not running';
    }
    els.vfsProviderStatusText.textContent = text;
  }

  if (els.virtualFilesFolderUnlocked) {
    const unlocked = Boolean(cfg.virtualFilesFolderUnlocked);
    els.virtualFilesFolderUnlocked.checked = unlocked;
    if (els.virtualFilesFolder) els.virtualFilesFolder.readOnly = !unlocked;
    if (els.pickVirtualFilesFolderButton) els.pickVirtualFilesFolderButton.disabled = !unlocked;
  }

  els.explorerShortcutName.value = cfg.explorerShortcutName || 'BoltBytes Sync';
  els.autoCreateExplorerShortcut.checked = Boolean(cfg.autoCreateExplorerShortcut);

  els.debugApi.checked = Boolean(cfg.debugApi);
  els.apiDebugLog.textContent = cfg.debugApi ? state.ui.apiLog.slice(-350).join('\n') : '';

  els.launchOnStartup.checked = Boolean(cfg.launchOnStartup);
  els.showNotifications.checked = Boolean(cfg.showNotifications);

  if (els.cacheAutoClean) els.cacheAutoClean.checked = cfg.cacheAutoClean !== false;
  if (els.cacheMaxAgeDays) els.cacheMaxAgeDays.value = String(cfg.cacheMaxAgeDays ?? 7);
  if (els.cacheMaxSizeMb) els.cacheMaxSizeMb.value = String(cfg.cacheMaxSizeMb ?? 1024);
  if (els.cacheInfoText) {
    const info = state.ui.cacheInfo || { root: '', sizeBytes: 0, fileCount: 0 };
    const loc = info.root ? `Location: ${info.root}` : '';
    const size = `Size: ${formatBytes(info.sizeBytes || 0)}`;
    const count = `Files: ${info.fileCount || 0}`;

    let cleanupText = '';
    const lc = info.lastCleanup;
    if (lc && (lc.deletedFiles || lc.freedBytes)) {
      cleanupText = `Last cleanup: freed ${formatBytes(lc.freedBytes || 0)} (${lc.deletedFiles || 0} files) ${formatAgeShort(lc.ranAt)}`;
    } else if (lc) {
      cleanupText = `Last cleanup: nothing to remove ${formatAgeShort(lc.ranAt)}`;
    }

    const parts = [loc, size, count, cleanupText].filter(Boolean);
    els.cacheInfoText.textContent = parts.join(' · ');
  }
  els.wizardEmail.value = cfg.email || '';
  els.wizardPassword.value = cfg.password || '';
  if (els.manualToken) els.manualToken.value = '';
  if (els.wizardToken) els.wizardToken.value = '';
  els.wizardRememberPassword.checked = Boolean(cfg.rememberPassword);
}

function renderRemoteFolders() {
  const cfg = state.config || {};
  const items = state.remoteFolders.items || [];
  const selectedId = cfg.remoteFolderId ? String(cfg.remoteFolderId) : '';

  if (state.remoteFolders.loading) {
    els.remoteFolderTrigger.textContent = 'Loading…';
    els.remoteFolderSummary.textContent = 'Loading cloud folders…';
    closeRemoteDropdown();
    return;
  }

  
  if (state.remoteFolders.error) {
    els.remoteFolderTrigger.textContent = 'Folder load failed';
    els.remoteFolderSummary.textContent = state.remoteFolders.error;
    els.remoteFolderMenu.replaceChildren();
    closeRemoteDropdown();
    return;
  }

if (!items.length) {
    els.remoteFolderTrigger.textContent = 'No cloud folders found';
    els.remoteFolderSummary.textContent = 'No cloud folders loaded yet.';
    els.remoteFolderMenu.replaceChildren();
    closeRemoteDropdown();
    return;
  }

  const selected = items.find(f => String(f.id) === selectedId) || (selectedId ? { id: selectedId, name: cfg.remoteFolderPathLabel || cfg.remoteFolderName || 'Selected folder', virtual: true } : items[0]);

  if (selected && state.config) {
    const nextLabel = formatRemoteFolderPathLabel(selected);
    if (state.config.remoteFolderId !== selected.id || !state.config.remoteFolderPathLabel) {
      state.config.remoteFolderId = selected.id;
      state.config.remoteFolderName = selected.name;
      state.config.remoteFolderPathLabel = nextLabel;
      scheduleSaveConfig();
    } else if (state.config.remoteFolderPathLabel !== nextLabel) {
      state.config.remoteFolderPathLabel = nextLabel;
      scheduleSaveConfig();
    }
  }


  els.remoteFolderTrigger.textContent = formatRemoteFolderPathLabel(selected) || 'Select folder…';
  els.remoteFolderSummary.textContent = `${items.length} folders found. Selected: ${formatRemoteFolderPathLabel(selected)}.`;

  const menu = els.remoteFolderMenu;
  menu.replaceChildren();

  for (const folder of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dropdown-item';
    btn.dataset.id = String(folder.id);
    btn.textContent = folder.name;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(folder.id) === String(selected.id) ? 'true' : 'false');
    btn.addEventListener('click', () => {
      closeRemoteDropdown();
      const breadcrumb = folder.id === '__root__'
        ? [{ id: '__root__', name: 'Root' }]
        : [{ id: '__root__', name: 'Root' }, { id: String(folder.id), name: String(folder.name) }];
      setSelectedRemoteFolder({ id: folder.id, name: folder.name, breadcrumb });
    });
    menu.appendChild(btn);
  }
}

function getConfigBreadcrumb(cfg) {
  const raw = cfg?.remoteFolderBreadcrumb;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(c => c && c.id)
    .map(c => ({ id: String(c.id), name: String(c.name || c.displayLabel || c.id) }));
}

function buildPathLabelFromBreadcrumb(breadcrumb) {
  const parts = breadcrumb.filter(c => c && c.id !== '__root__').map(c => c.name);
  return parts.length ? `/${parts.join('/')}` : '/';
}

function setSelectedRemoteFolder({ id, name, breadcrumb }) {
  if (!state.config) return;
  const folderId = String(id);
  const folderName = String(name || folderId);
  const bc = Array.isArray(breadcrumb) ? breadcrumb : [];

  state.config.remoteFolderId = folderId;
  state.config.remoteFolderName = folderName;
  state.config.remoteFolderBreadcrumb = bc
    .filter(c => c && c.id && c.id !== '__root__')
    .map(c => ({ id: String(c.id), name: String(c.name || c.id) }));
  state.config.remoteFolderPathLabel = buildPathLabelFromBreadcrumb([{ id: '__root__', name: 'Root' }, ...state.config.remoteFolderBreadcrumb]);

  scheduleSaveConfig();
  renderRemoteFolders();
  renderStatus();
  renderPauseButton();
}

function openFolderBrowser() {
  if (!isAuthenticated(state.config)) {
    openSettingsModal('account');
    return;
  }

  state.folderBrowser.open = true;
  setModalOpen(els.folderBrowserModal, true);

  // Start from previously selected breadcrumb if available.
  const cfg = state.config || {};
  const crumbs = getConfigBreadcrumb(cfg);
  const base = [{ id: '__root__', name: 'Root' }, ...crumbs];
  state.folderBrowser.breadcrumb = base.length ? base : [{ id: '__root__', name: 'Root' }];

  loadFolderBrowserCurrent();
}

function closeFolderBrowser() {
  state.folderBrowser.open = false;
  setModalOpen(els.folderBrowserModal, false);
}

function getFolderBrowserParentId() {
  const last = state.folderBrowser.breadcrumb[state.folderBrowser.breadcrumb.length - 1];
  if (!last || last.id === '__root__') return '';
  return String(last.id);
}

async function loadFolderBrowserCurrent() {
  state.folderBrowser.loading = true;
  state.folderBrowser.error = '';
  renderFolderBrowser();

  try {
    const parentId = getFolderBrowserParentId();
    const env = await window.desktopSync.listRemoteFolderChildren(state.config, parentId);
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();

    const folders = Array.isArray(env?.folders) ? env.folders : [];
    state.folderBrowser.items = folders
      .filter(f => f && f.id != null)
      .map(f => ({
        id: String(f.id),
        name: String(f.name || f.displayLabel || f.file_name || f.fileName || f.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));

    state.folderBrowser.loading = false;
    renderFolderBrowser();
  } catch (err) {
    state.folderBrowser.loading = false;
    state.folderBrowser.items = [];
    state.folderBrowser.error = String(err && err.message ? err.message : err);
    renderFolderBrowser();
  }
}

function navigateFolderBrowserTo(folder) {
  if (!folder) return;
  state.folderBrowser.breadcrumb = [...state.folderBrowser.breadcrumb, { id: String(folder.id), name: String(folder.name) }];
  loadFolderBrowserCurrent();
}

function navigateFolderBrowserToIndex(index) {
  const clamped = Math.max(0, Math.min(index, state.folderBrowser.breadcrumb.length - 1));
  state.folderBrowser.breadcrumb = state.folderBrowser.breadcrumb.slice(0, clamped + 1);
  loadFolderBrowserCurrent();
}

function renderFolderBrowser() {
  if (!els.folderBrowserModal) return;

  els.folderBrowserLoading.hidden = !state.folderBrowser.loading;
  els.folderBrowserError.hidden = !state.folderBrowser.error;
  els.folderBrowserError.textContent = state.folderBrowser.error || '';

  if (els.folderBrowserCreateStatus) {
    const msg = state.folderBrowser.createStatus || '';
    els.folderBrowserCreateStatus.hidden = !msg;
    els.folderBrowserCreateStatus.textContent = msg;
    els.folderBrowserCreateStatus.className = `helper ${state.folderBrowser.createStatusKind || 'muted'}`;
  }
  if (els.folderBrowserCreateButton) {
    els.folderBrowserCreateButton.disabled = state.folderBrowser.loading;
  }

  // Breadcrumb
  els.folderBreadcrumb.replaceChildren();
  state.folderBrowser.breadcrumb.forEach((crumb, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = idx === 0 ? '/' : crumb.name;
    btn.addEventListener('click', () => navigateFolderBrowserToIndex(idx));
    els.folderBreadcrumb.appendChild(btn);

    if (idx < state.folderBrowser.breadcrumb.length - 1) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      els.folderBreadcrumb.appendChild(sep);
    }
  });

  // List
  els.folderBrowserList.replaceChildren();
  if (!state.folderBrowser.items.length && !state.folderBrowser.loading && !state.folderBrowser.error) {
    const li = document.createElement('li');
    li.className = 'helper muted';
    li.textContent = 'No folders found in this location.';
    els.folderBrowserList.appendChild(li);
    return;
  }

  for (const folder of state.folderBrowser.items) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'folder-item';
    row.innerHTML = '<span class="folder-icon">📁</span><span></span>';
    row.querySelector('span:last-child').textContent = folder.name;
    row.addEventListener('click', () => navigateFolderBrowserTo(folder));
    li.appendChild(row);
    els.folderBrowserList.appendChild(li);
  }
}

function renderAll() {
  renderAccount();
  renderStatus();
  renderPauseButton();
  renderForms();
  renderRemoteFolders();
  renderTrash();
  renderTransfers();
  renderActivity();
  showWizardIfNeeded();
}

async function loadExplorerShortcutStatus() {
  try {
    const status = await window.desktopSync.getExplorerShortcutStatus(state.config || {});
    els.shortcutStatus.textContent = status?.message || (status?.exists ? 'Shortcut exists.' : 'No shortcut path yet.');
  } catch (err) {
    els.shortcutStatus.textContent = `Shortcut check failed: ${String(err && err.message ? err.message : err)}`;
  }
}

async function loadRemoteFolders() {
  if (!isAuthenticated(state.config)) {
    els.remoteFolderSummary.textContent = 'Sign in to load cloud folders.';
    return;
  }

  state.remoteFolders.loading = true;
  renderRemoteFolders();

  try {
    const env = await window.desktopSync.listRemoteFolders(state.config);
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();

    const folders = Array.isArray(env?.folders) ? env.folders : [];

state.remoteFolders.error = '';

state.remoteFolders.items = folders
  .filter(f => f && f.id !== undefined && f.id !== null && String(f.id).trim() !== '')
  .map(f => ({
    id: String(f.id),
    name: String(f.displayLabel || f.name || f.file_name || f.fileName || f.path || f.id),
  }));

const cfgSelectedId = state.config?.remoteFolderId ? String(state.config.remoteFolderId) : '';
if (cfgSelectedId && !state.remoteFolders.items.some(f => String(f.id) === cfgSelectedId)) {
  state.remoteFolders.items.unshift({
    id: cfgSelectedId,
    name: String(state.config.remoteFolderPathLabel || state.config.remoteFolderName || 'Selected folder'),
    virtual: true,
  });
}

if (!state.config.remoteFolderId && state.remoteFolders.items.length) {
  state.config.remoteFolderId = state.remoteFolders.items[0].id;
  state.config.remoteFolderName = state.remoteFolders.items[0].name;
  state.config.remoteFolderPathLabel = formatRemoteFolderPathLabel(state.remoteFolders.items[0]);
  scheduleSaveConfig();
}

    state.remoteFolders.loading = false;
    renderAll();
  } catch (err) {
    state.remoteFolders.loading = false;
    state.remoteFolders.items = [];
    state.remoteFolders.error = `Folder load failed: ${String(err && err.message ? err.message : err)}`;
    renderRemoteFolders();
  }
}

async function loadTrash() {
  if (!isAuthenticated(state.config)) {
    state.trash.items = [];
    state.trash.error = 'Sign in to view Trash.';
    renderTrash();
    return;
  }

  state.trash.loading = true;
  state.trash.error = '';
  renderTrash();

  try {
    const env = await window.desktopSync.listTrash(state.config || {});
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
    state.trash.items = Array.isArray(env?.entries) ? env.entries : [];
    state.trash.loading = false;
    renderTrash();
  } catch (err) {
    state.trash.loading = false;
    state.trash.items = [];
    state.trash.error = String(err && err.message ? err.message : err);
    renderTrash();
  }
}

function formatDeletedAt(entry) {
  const raw = entry?.deleted_at || entry?.deletedAt;
  if (!raw) return '—';
  try {
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return String(raw);
    return dt.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(raw);
  }
}

function getEntryTypeLabel(entry) {
  const raw = String(entry?.type || entry?.mime || '').toLowerCase();
  if (!raw) return 'file';
  if (raw.includes('folder')) return 'folder';
  if (raw === 'image') return 'image';
  if (raw === 'video') return 'video';
  if (raw === 'audio') return 'audio';
  if (raw === 'pdf') return 'pdf';
  return raw;
}

function renderTrash() {
  if (!els.trashListBody) return;

  const query = String(state.trash.query || '').trim().toLowerCase();
  const items = Array.isArray(state.trash.items) ? state.trash.items : [];
  const filtered = query
    ? items.filter(item => String(item?.name || item?.file_name || '').toLowerCase().includes(query))
    : items;

  els.trashLoading.hidden = !state.trash.loading;
  els.trashError.hidden = !state.trash.error;
  els.trashError.textContent = state.trash.error || '';

  if (els.trashCount) {
    els.trashCount.textContent = `${filtered.length} item(s)`;
  }

  const selected = state.trash.selected;
  // Keep selection only for currently visible items.
  const visibleIds = new Set(filtered.map(item => String(item?.id ?? '').trim()).filter(Boolean));
  for (const id of Array.from(selected)) {
    if (!visibleIds.has(id)) selected.delete(id);
  }

  const selectedIds = Array.from(selected);
  if (els.trashRestoreButton) els.trashRestoreButton.disabled = selectedIds.length === 0 || state.trash.loading;
  if (els.trashDeleteButton) els.trashDeleteButton.disabled = selectedIds.length === 0 || state.trash.loading;
  if (els.trashEmptyButton) els.trashEmptyButton.disabled = filtered.length === 0 || state.trash.loading;
  if (els.trashRefreshButton) els.trashRefreshButton.disabled = state.trash.loading;

  els.trashListBody.replaceChildren();

  if (!filtered.length && !state.trash.loading) {
    const empty = document.createElement('div');
    empty.className = 'helper muted';
    empty.style.padding = '12px';
    empty.textContent = query ? 'No matching items.' : 'Trash is empty.';
    els.trashListBody.appendChild(empty);
    return;
  }

  for (const entry of filtered) {
    const id = String(entry?.id ?? '').trim();
    if (!id) continue;

    const row = document.createElement('div');
    row.className = 'trash-item';
    row.setAttribute('role', 'listitem');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'trash-checkbox';
    checkbox.checked = selected.has(id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
      renderTrash();
    });

    const nameBox = document.createElement('div');
    nameBox.className = 'trash-name';
    const name = document.createElement('strong');
    name.textContent = String(entry?.name || entry?.file_name || entry?.fileName || id);
    const sub = document.createElement('span');
    sub.className = 'trash-sub';
    sub.textContent = entry?.path ? `Path: ${entry.path}` : '';
    nameBox.appendChild(name);
    if (sub.textContent) nameBox.appendChild(sub);

    const typePill = document.createElement('span');
    typePill.className = 'trash-type-pill';
    typePill.textContent = getEntryTypeLabel(entry);

    const deletedAt = document.createElement('span');
    deletedAt.className = 'muted';
    deletedAt.textContent = formatDeletedAt(entry);

    row.appendChild(checkbox);
    row.appendChild(nameBox);
    row.appendChild(typePill);
    row.appendChild(deletedAt);

    els.trashListBody.appendChild(row);
  }
}


function deriveStatusFromPayload(payload) {
  const statusText = payload?.status ?? '';
  const syncInProgress = Boolean(payload?.syncInProgress);
  const latest = payload?.latestSyncResult;

  if (syncInProgress) {
    state.status.headline = 'Syncing…';
    state.status.kind = 'busy';
  } else if (statusText.toLowerCase().includes('failed')) {
    state.status.headline = 'Sync failed';
    state.status.kind = 'error';
  } else if (statusText.toLowerCase().includes('last sync') || statusText.toLowerCase().includes('synced')) {
    state.status.headline = 'All synced!';
    state.status.kind = 'ok';
  } else {
    state.status.headline = statusText || 'Ready';
    state.status.kind = 'idle';
  }

  state.status.text = statusText || '';
  if (state.config?.lastSyncContext?.finishedAt) state.status.lastSync = state.config.lastSyncContext.finishedAt;
  if (state.config?.lastSyncContext?.remoteFolderName) state.status.remoteFolderName = state.config.lastSyncContext.remoteFolderName;
  if (latest?.live && syncInProgress) {
    const up = latest.live.uploading ?? 0;
    const down = latest.live.downloading ?? 0;
    if (up || down) state.status.text = `${statusText} (uploading: ${up}, downloading: ${down})`;
  }
}

async function loginFromFields({ email, password, rememberPassword }) {
  setAccountError('');
  setWizardError('');

  const payload = {
    ...(state.config || {}),    email: (email || '').trim(),
    password: password || '',
    rememberPassword: Boolean(rememberPassword),
  };

  if (!payload.email || !payload.password) {
    const msg = 'Enter your email and password to sign in.';
    setAccountError(msg);
    setWizardError(msg);
    throw new Error(msg);
  }

  setStatusKind('busy');
  state.status.headline = 'Signing in…';
  state.status.text = 'Kontakter BoltBytes…';
  renderStatus();
  renderPauseButton();

  const env = await window.desktopSync.login(sanitizeConfigForMain(payload));
  applyEnvelope(env);

  // Ensure persisted.
  const savedEnv = await window.desktopSync.saveConfig(sanitizeConfigForMain(state.config));
  applyEnvelope(savedEnv);

  state.status.headline = 'Connected';
  state.status.text = 'Signed in.';
  state.status.kind = 'ok';
  renderStatus();
  renderPauseButton();

  await loadExplorerShortcutStatus();
  closeSettingsModal();
  showWizardIfNeeded();
  renderAll();

  // Prefetch folders to make picker instant.
  loadRemoteFolders().catch(() => {});
}


async function useToken(token) {
  setAccountError('');
  setWizardError('');

  const raw = String(token || '').trim();
  if (!raw) {
    const msg = 'Paste a bearer token.';
    setAccountError(msg);
    setWizardError(msg);
    throw new Error(msg);
  }

  state.config.token = raw;
  state.config.isLoggedIn = true;
  state.config.tokenMasked = maskToken(raw);

  const savedEnv = await window.desktopSync.saveConfig(sanitizeConfigForMain(state.config));
  applyEnvelope(savedEnv);

  state.status.headline = 'Connected';
  state.status.text = 'Token gemt.';
  state.status.kind = 'ok';
  renderStatus();
  renderPauseButton();

  await loadExplorerShortcutStatus();
  closeSettingsModal();
  showWizardIfNeeded();
  renderAll();

  loadRemoteFolders().catch(() => {});
}

async function logout() {
  setAccountError('');
  try {
    const env = await window.desktopSync.logout(state.config || {});
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
    const savedEnv = await window.desktopSync.saveConfig(sanitizeConfigForMain(state.config));
    applyEnvelope(savedEnv);
    state.remoteFolders.items = [];
    pushApiLogLine('Logged out.');
  } catch (err) {
    pushApiLogLine(`logout failed: ${String(err && err.message ? err.message : err)}`);
  } finally {
    renderAll();
    showWizardIfNeeded();
  }
}

async function runSelfTest() {
  els.apiSelfTestOutput.textContent = '';
  if (!isAuthenticated(state.config)) {
    els.apiSelfTestOutput.textContent = 'Not logged in.';
    return;
  }

  try {
    const env = await window.desktopSync.listRemoteFolders(state.config);
    const folders = Array.isArray(env?.folders) ? env.folders : [];
    const folderCount = folders.filter(f => String(f?.type || '').toLowerCase() === 'folder').length;
    els.apiSelfTestOutput.textContent = `OK\nEntries returned: ${folders.length}\nFolders(type=folder): ${folderCount}`;
  } catch (err) {
    els.apiSelfTestOutput.textContent = `FAILED\n${String(err && err.message ? err.message : err)}`;
  }
}

function bindFormListeners() {
  els.pickLocalFolderButton.addEventListener('click', async () => {
    const result = await window.desktopSync.pickFolder();
    const folderPath = typeof result === 'string' ? result : result?.folderPath;
    if (!folderPath) return;
    state.config.localFolder = folderPath;
    scheduleSaveConfig();
    renderForms();
  });

  els.refreshRemoteFoldersButton.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await loadRemoteFolders();
  });

  if (els.browseRemoteFoldersButton) {
    els.browseRemoteFoldersButton.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRemoteDropdown();
      openFolderBrowser();
    });
  }

  if (els.openSelectiveSyncButton) {
    els.openSelectiveSyncButton.addEventListener('click', (e) => {
      e.preventDefault();
      openSelectiveSyncModal();
    });
  }

  if (els.clearSelectiveSyncButton) {
    els.clearSelectiveSyncButton.addEventListener('click', () => {
      state.config.selectiveSyncExcludedFolders = [];
      scheduleSaveConfig();
      renderSelectiveSyncSummary();
    });
  }

  els.remoteFolderTrigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleRemoteDropdown();
  });

  els.enableDownloadSync.addEventListener('change', () => {
    state.config.enableDownloadSync = els.enableDownloadSync.checked;
    scheduleSaveConfig();
  });

  if (els.enableUploadSync) {
    els.enableUploadSync.addEventListener('change', () => {
      state.config.enableUploadSync = els.enableUploadSync.checked;
      scheduleSaveConfig();
    });
  }

  els.autoSyncEnabled.addEventListener('change', () => {
    state.config.autoSyncEnabled = els.autoSyncEnabled.checked;
    scheduleSaveConfig();
  });  if (els.wifiOnly) {
    els.wifiOnly.addEventListener('change', () => {
      state.config.wifiOnly = els.wifiOnly.checked;
      scheduleSaveConfig();
    });
  }

  if (els.virtualFilesEnabled) {
    els.virtualFilesEnabled.addEventListener('change', async () => {
      state.config.virtualFilesEnabled = els.virtualFilesEnabled.checked;
      scheduleSaveConfig();
      renderForms();
    });
  }


  if (els.virtualFilesFolderUnlocked) {
    els.virtualFilesFolderUnlocked.addEventListener('change', async () => {
      const unlocked = els.virtualFilesFolderUnlocked.checked;
      state.config.virtualFilesFolderUnlocked = unlocked;
      if (!unlocked) {
        try {
          const def = await window.desktopSync.getDefaultVirtualFilesFolder();
          if (def) state.config.virtualFilesFolder = def;
        } catch {
          // Best-effort.
        }
      }
      scheduleSaveConfig();
      renderForms();
    });
  }

  if (els.pickVirtualFilesFolderButton) {
    els.pickVirtualFilesFolderButton.addEventListener('click', async () => {
      if (!state.config.virtualFilesFolderUnlocked) return;
      const result = await window.desktopSync.pickFolder();
      const folderPath = typeof result === 'string' ? result : result?.folderPath;
      if (!folderPath) return;
      state.config.virtualFilesFolder = folderPath;
      scheduleSaveConfig();
      renderForms();
    });
  }

  if (els.openVirtualFilesFolderButton) {
    els.openVirtualFilesFolderButton.addEventListener('click', async () => {
      const folderPath = state.config.virtualFilesFolder;
      if (folderPath) await window.desktopSync.openPath(folderPath);
    });
  }



  els.pollIntervalSeconds.addEventListener('change', () => {
    const n = Number(els.pollIntervalSeconds.value);
    state.config.pollIntervalSeconds = Number.isFinite(n) ? Math.max(10, Math.round(n)) : 30;
    scheduleSaveConfig();
  });

  els.syncConcurrency.addEventListener('change', () => {
    const n = Number(els.syncConcurrency.value);
    state.config.syncConcurrency = Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3;
    scheduleSaveConfig();
  });

  els.conflictStrategy.addEventListener('change', () => {
    state.config.conflictStrategy = els.conflictStrategy.value || 'ask';
    scheduleSaveConfig();
  });

  els.moveLocalDeletesToTrash.addEventListener('change', () => {
    state.config.moveLocalDeletesToTrash = els.moveLocalDeletesToTrash.checked;
    scheduleSaveConfig();
  });  if (els.ignoreRulesText) {
    const updateIgnore = () => {
      state.config.ignoreRulesText = String(els.ignoreRulesText.value || '');
      scheduleSaveConfig();
    };
    els.ignoreRulesText.addEventListener('change', updateIgnore);
    els.ignoreRulesText.addEventListener('blur', updateIgnore);

    if (els.ignoreInsertPresetsButton) {
      els.ignoreInsertPresetsButton.addEventListener('click', () => {
        const presets = ['Thumbs.db', '.DS_Store', '*.tmp', '~$*', '*.swp', '*.part', 'node_modules/', '.git/'];
        const existing = new Set(String(els.ignoreRulesText.value || '').split(/\r?\n/).map(v => v.trim()).filter(Boolean));
        for (const p of presets) existing.add(p);
        els.ignoreRulesText.value = Array.from(existing).join('\n') + '\n';
        state.config.ignoreRulesText = els.ignoreRulesText.value;
        scheduleSaveConfig();
      });
    }

    if (els.ignoreClearButton) {
      els.ignoreClearButton.addEventListener('click', () => {
        els.ignoreRulesText.value = '';
        state.config.ignoreRulesText = '';
        scheduleSaveConfig();
      });
    }
  }



  els.explorerShortcutName.addEventListener('input', () => {
    state.config.explorerShortcutName = els.explorerShortcutName.value;
    scheduleSaveConfig();
  });

  els.autoCreateExplorerShortcut.addEventListener('change', () => {
    state.config.autoCreateExplorerShortcut = els.autoCreateExplorerShortcut.checked;
    scheduleSaveConfig();
  });

  els.createShortcutButton.addEventListener('click', async () => {
    try {
      const status = await window.desktopSync.createExplorerShortcut(state.config || {});
      els.shortcutStatus.textContent = status?.message || 'Shortcut created.';
      await loadExplorerShortcutStatus();
    } catch (err) {
      els.shortcutStatus.textContent = `Create failed: ${String(err && err.message ? err.message : err)}`;
    }
  });

  els.removeShortcutButton.addEventListener('click', async () => {
    try {
      const status = await window.desktopSync.removeExplorerShortcut(state.config || {});
      els.shortcutStatus.textContent = status?.message || 'Shortcut removed.';
      await loadExplorerShortcutStatus();
    } catch (err) {
      els.shortcutStatus.textContent = `Remove failed: ${String(err && err.message ? err.message : err)}`;
    }
  });

  els.debugApi.addEventListener('change', () => {
    state.config.debugApi = els.debugApi.checked;
    scheduleSaveConfig();
    renderForms();
  });

  els.clearApiLogButton.addEventListener('click', () => {
    state.ui.apiLog = [];
    els.apiDebugLog.textContent = '';
  });
  els.email.addEventListener('input', () => {
    state.config.email = els.email.value;
    scheduleSaveConfig();
    renderAccount();
  });

  els.password.addEventListener('input', () => {
    state.config.password = els.password.value;
    scheduleSaveConfig();
  });

  els.rememberPassword.addEventListener('change', () => {
    state.config.rememberPassword = els.rememberPassword.checked;
    scheduleSaveConfig();
  });


  if (els.useTokenButton) {
    els.useTokenButton.addEventListener('click', async () => {
      try {
        await useToken(els.manualToken.value);
      } catch (err) {
        setAccountError(String(err && err.message ? err.message : err));
      }
    });
  }

  els.loginButton.addEventListener('click', async () => {
    try {
      await loginFromFields({        email: els.email.value,
        password: els.password.value,
        rememberPassword: els.rememberPassword.checked,
      });
    } catch (err) {
      setAccountError(String(err && err.message ? err.message : err));
      state.status.headline = 'Login failed';
      state.status.text = 'Check credentials / network.';
      state.status.kind = 'error';
      renderStatus();
  renderPauseButton();
    }
  });

  els.logoutButton.addEventListener('click', logout);

  els.launchOnStartup.addEventListener('change', () => {
    state.config.launchOnStartup = els.launchOnStartup.checked;
    scheduleSaveConfig();
  });

  els.showNotifications.addEventListener('change', () => {
    state.config.showNotifications = els.showNotifications.checked;
    scheduleSaveConfig();
  });


  if (els.cacheAutoClean) {
    els.cacheAutoClean.addEventListener('change', () => {
      state.config.cacheAutoClean = els.cacheAutoClean.checked;
      scheduleSaveConfig();
      renderForms();
    });
  }

  if (els.cacheMaxAgeDays) {
    els.cacheMaxAgeDays.addEventListener('change', () => {
      const v = Number(els.cacheMaxAgeDays.value);
      state.config.cacheMaxAgeDays = Number.isFinite(v) ? Math.max(1, Math.floor(v)) : 7;
      scheduleSaveConfig();
      renderForms();
    });
  }

  if (els.cacheMaxSizeMb) {
    els.cacheMaxSizeMb.addEventListener('change', () => {
      const v = Number(els.cacheMaxSizeMb.value);
      state.config.cacheMaxSizeMb = Number.isFinite(v) ? Math.max(50, Math.floor(v)) : 1024;
      scheduleSaveConfig();
      renderForms();
    });
  }

  if (els.openCacheFolderButton) {
    els.openCacheFolderButton.addEventListener('click', async () => {
      const info = state.ui.cacheInfo || {};
      if (info.root) await window.desktopSync.openPath(info.root);
    });
  }

  if (els.runCacheCleanupButton) {
    els.runCacheCleanupButton.addEventListener('click', async () => {
      try {
        const res = await window.desktopSync.runCacheCleanup();
        if (res?.info) state.ui.cacheInfo = { ...res.info, lastCleanup: res.lastCleanup || res.info.lastCleanup };
      } catch {
        // Best-effort.
      }
      await refreshCacheInfo();
      renderForms();
    });
  }

  els.apiSelfTestButton.addEventListener('click', runSelfTest);

  if (els.trashRefreshButton) {
    els.trashRefreshButton.addEventListener('click', loadTrash);
  }
  if (els.trashSearch) {
    els.trashSearch.addEventListener('input', () => {
      state.trash.query = els.trashSearch.value;
      renderTrash();
    });
  }
  if (els.trashRestoreButton) {
    els.trashRestoreButton.addEventListener('click', async () => {
      const ids = Array.from(state.trash.selected);
      if (!ids.length) return;
      try {
        const env = await window.desktopSync.restoreTrashEntries(state.config || {}, ids);
        applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
        state.trash.selected.clear();
        state.trash.items = Array.isArray(env?.entries) ? env.entries : state.trash.items;
        renderTrash();
      } catch (err) {
        state.trash.error = String(err && err.message ? err.message : err);
        renderTrash();
      }
    });
  }
  if (els.trashDeleteButton) {
    els.trashDeleteButton.addEventListener('click', async () => {
      const ids = Array.from(state.trash.selected);
      if (!ids.length) return;
      const ok = window.confirm(`Delete ${ids.length} item(s) permanently? This cannot be undone.`);
      if (!ok) return;
      try {
        const env = await window.desktopSync.deleteTrashEntries(state.config || {}, ids);
        applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
        state.trash.selected.clear();
        state.trash.items = Array.isArray(env?.entries) ? env.entries : state.trash.items;
        renderTrash();
      } catch (err) {
        state.trash.error = String(err && err.message ? err.message : err);
        renderTrash();
      }
    });
  }
  if (els.trashEmptyButton) {
    els.trashEmptyButton.addEventListener('click', async () => {
      const allIds = (Array.isArray(state.trash.items) ? state.trash.items : []).map(item => String(item?.id ?? '').trim()).filter(Boolean);
      if (!allIds.length) return;
      const ok = window.confirm(`Empty trash (${allIds.length} item(s)) permanently? This cannot be undone.`);
      if (!ok) return;
      try {
        const env = await window.desktopSync.deleteTrashEntries(state.config || {}, allIds);
        applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
        state.trash.selected.clear();
        state.trash.items = Array.isArray(env?.entries) ? env.entries : [];
        renderTrash();
      } catch (err) {
        state.trash.error = String(err && err.message ? err.message : err);
        renderTrash();
      }
    });
  }


  if (els.wizardUseTokenButton) {
    els.wizardUseTokenButton.addEventListener('click', async () => {
      try {
        await useToken(els.wizardToken.value);
      } catch (err) {
        setWizardError(String(err && err.message ? err.message : err));
      }
    });
  }

  els.wizardLoginButton.addEventListener('click', async () => {
    try {
      await loginFromFields({        email: els.wizardEmail.value,
        password: els.wizardPassword.value,
        rememberPassword: els.wizardRememberPassword.checked,
      });
      setWizardError('');
    } catch (err) {
      setWizardError(String(err && err.message ? err.message : err));
    }
  });
}

function bindUiListeners() { 
  if (els.selectiveSyncCloseButton) {
    els.selectiveSyncCloseButton.addEventListener('click', () => closeSelectiveSyncModal());
  }
  if (els.selectiveSyncCancelButton) {
    els.selectiveSyncCancelButton.addEventListener('click', () => closeSelectiveSyncModal());
  }
  if (els.selectiveSyncSaveButton) {
    els.selectiveSyncSaveButton.addEventListener('click', () => {
      state.config.selectiveSyncExcludedFolders = Array.from(state.selectiveSync.excluded).sort((a, b) => a.localeCompare(b, 'en'));
      scheduleSaveConfig();
      closeSelectiveSyncModal();
    });
  }
  if (els.selectiveSyncSearch) {
    els.selectiveSyncSearch.addEventListener('input', () => {
      state.selectiveSync.query = els.selectiveSyncSearch.value || '';
      renderSelectiveSync();
    });
  }
  if (els.selectiveSyncSelectAllButton) {
    els.selectiveSyncSelectAllButton.addEventListener('click', () => {
      state.selectiveSync.excluded = new Set();
      renderSelectiveSync();
    });
  }
  if (els.selectiveSyncSelectNoneButton) {
    els.selectiveSyncSelectNoneButton.addEventListener('click', () => {
      const folders = Array.isArray(state.selectiveSync.folderPaths) ? state.selectiveSync.folderPaths : [];
      state.selectiveSync.excluded = new Set(folders);
      renderSelectiveSync();
    });
  }


  els.accountMenuButton.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAccountMenu();
  });

  els.menuSettings.addEventListener('click', () => openSettingsModal('sync'));
  els.openSettingsButton.addEventListener('click', () => openSettingsModal('sync'));

  els.settingsCloseButton.addEventListener('click', () => {
    if (isAuthenticated(state.config)) closeSettingsModal();
  });

if (els.folderBrowserCloseButton) {
  els.folderBrowserCloseButton.addEventListener('click', () => closeFolderBrowser());
}
if (els.folderBrowserCancelButton) {
  els.folderBrowserCancelButton.addEventListener('click', () => closeFolderBrowser());
}
if (els.folderBrowserSelectButton) {
  els.folderBrowserSelectButton.addEventListener('click', () => {
    const crumbs = state.folderBrowser.breadcrumb || [{ id: '__root__', name: 'Root' }];
    const last = crumbs[crumbs.length - 1] || { id: '__root__', name: 'Root' };
    setSelectedRemoteFolder({
      id: last.id,
      name: last.id === '__root__' ? 'Root' : last.name,
      breadcrumb: crumbs,
    });
    closeFolderBrowser();
  });
}

if (els.folderBrowserCreateButton) {
  els.folderBrowserCreateButton.addEventListener('click', async () => {
    const folderName = String(els.folderBrowserNewName?.value || '').trim();
    if (!folderName) return;

    state.folderBrowser.createStatusKind = 'muted';
    state.folderBrowser.createStatus = 'Creating folder…';
    renderFolderBrowser();

    try {
      const parentId = getFolderBrowserParentId();
      const env = await window.desktopSync.createRemoteFolder(state.config || {}, parentId, folderName);
      applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();

      const folders = Array.isArray(env?.folders) ? env.folders : [];
      state.folderBrowser.items = folders
        .filter(f => f && f.id != null)
        .map(f => ({ id: String(f.id), name: String(f.name || f.displayLabel || f.file_name || f.fileName || f.id) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));

      if (els.folderBrowserNewName) els.folderBrowserNewName.value = '';
      state.folderBrowser.createStatusKind = 'muted';
      state.folderBrowser.createStatus = `Folder "${folderName}" created.`;
      renderFolderBrowser();
      setTimeout(() => {
        state.folderBrowser.createStatus = '';
        renderFolderBrowser();
      }, 1600);
    } catch (err) {
      state.folderBrowser.createStatusKind = 'danger';
      state.folderBrowser.createStatus = String(err && err.message ? err.message : err);
      renderFolderBrowser();
    }
  });
}

  for (const btn of els.tabButtons) {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
  }

  els.menuAddAccount.addEventListener('click', () => {
    openSettingsModal('account');
  });

  els.menuExit.addEventListener('click', () => window.close());

  els.openLocalFolderButton.addEventListener('click', async () => {
    try {
      await window.desktopSync.openLocalFolder(state.config || {});
    } catch (err) {
      pushApiLogLine(`openLocalFolder failed: ${String(err && err.message ? err.message : err)}`);
    }
  });

  els.syncNowButton.addEventListener('click', async () => {
    if (!isAuthenticated(state.config)) {
      openSettingsModal('account');
      showWizardIfNeeded();
      return;
    }

    try {
      setStatusKind('busy');
      state.status.headline = 'Syncing…';
      state.status.text = 'Running sync now.';
      renderStatus();
  renderPauseButton();

      const env = await window.desktopSync.runSync(state.config || {});
      applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();

      state.status.kind = 'ok';
      state.status.headline = 'All synced!';
      state.status.text = env?.status || 'Sync completed.';
      renderStatus();
  renderPauseButton();
      renderTransfers();
  renderActivity();
    } catch (err) {
      state.status.kind = 'error';
      state.status.headline = 'Sync failed';
      state.status.text = String(err && err.message ? err.message : err);
      renderStatus();
  renderPauseButton();
    }
  });

  els.clearActivityButton.addEventListener('click', () => {
    state.ui.activity = [];
    renderTransfers();
  renderActivity();
  });

  document.addEventListener('click', (e) => {
    const target = e.target;

    if (state.ui.accountMenuOpen && !els.accountMenu.contains(target) && !els.accountMenuButton.contains(target)) {
      closeAccountMenu();
    }
    if (state.ui.remoteDropdownOpen && !els.remoteFolderMenu.contains(target) && !els.remoteFolderTrigger.contains(target)) {
      closeRemoteDropdown();
    }
    if (state.ui.settingsOpen) {
      const backdrop = target && target.closest && target.closest('[data-close="settings"]');
      if (backdrop && isAuthenticated(state.config)) closeSettingsModal();
    }
    if (state.folderBrowser.open) {
      const backdrop = target && target.closest && target.closest('[data-close="folderBrowser"]');
      if (backdrop) closeFolderBrowser();
    }
    if (state.selectiveSync.open) {
      const backdrop = target && target.closest && target.closest('[data-close="selectiveSync"]');
      if (backdrop) closeSelectiveSyncModal();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.ui.remoteDropdownOpen) closeRemoteDropdown();
    if (state.ui.accountMenuOpen) closeAccountMenu();
    if (state.ui.settingsOpen && isAuthenticated(state.config)) closeSettingsModal();
    if (state.folderBrowser.open) closeFolderBrowser();
    if (state.selectiveSync.open) closeSelectiveSyncModal();
  });
}

async function bootstrap() {
  assertElements();

  // Render + bind immediately so the UI remains usable even if IPC/config load fails.
  if (!state.config) state.config = {};
  renderAll();
  bindUiListeners();
  bindFormListeners();

  let env = null;
  try {
    if (!window.desktopSync) throw new Error('Desktop bridge (preload) is not available.');
    env = await window.desktopSync.loadConfig();
    applyEnvelope(env);
    await refreshCacheInfo();
    renderAll();
  } catch (err) {
    state.status.headline = 'Initialization error';
    state.status.detail = String(err && err.message ? err.message : err);
    renderAll();
    // eslint-disable-next-line no-console
    console.error(err);
    return;
  }


  // Initial status from config.
  if (state.config?.lastSyncContext?.finishedAt) state.status.lastSync = state.config.lastSyncContext.finishedAt;
  if (state.config?.lastSyncContext?.remoteFolderName) state.status.remoteFolderName = state.config.lastSyncContext.remoteFolderName;

  const authenticated = isAuthenticated(state.config);
  state.status.headline = authenticated ? 'Ready' : 'Not signed in';
  state.status.kind = authenticated ? 'idle' : 'warn';
  state.status.text = (typeof env?.status === 'string' && env.status)
    ? env.status
    : (authenticated ? 'Ready to sync.' : 'Sign in to get started.');


  renderAll();

  const removeStatus = window.desktopSync.onStatus((payload) => {
    deriveStatusFromPayload(payload);
    renderStatus();
  renderPauseButton();
  });

  const removeVfsStatus = window.desktopSync.onVfsStatus((payload) => {
    state.ui.vfsStatus = payload;
    renderForms();
  });


  const removeActivity = window.desktopSync.onActivity((item) => {
    const entry = {
      title: item?.message || item?.title || 'Activity',
      subtitle: item?.detail || item?.action || item?.level || '',
      timestamp: item?.at || '',
    };
    state.ui.activity.unshift(entry);
    state.ui.activity = state.ui.activity.slice(0, 100);
    renderTransfers();
  renderActivity();
  });

  const removeLive = window.desktopSync.onSyncLive((payload) => {
    state.ui.liveSync = {
      ts: payload?.ts || new Date().toISOString(),
      completed: Number(payload?.completed || 0),
      total: Number(payload?.total || 0),
      live: payload?.live || { uploading: 0, downloading: 0, conflicts: 0 },
      active: Array.isArray(payload?.active) ? payload.active : [],
      pendingOpsCount: Number(payload?.pendingOpsCount || 0),
    };
    renderTransfers();
  });

  const removeApi = window.desktopSync.onApiDebug((payload) => {
    pushApiLogLine(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });

  window.addEventListener('beforeunload', () => {
    removeStatus?.();
    removeVfsStatus?.();
    removeActivity?.();
    removeApi?.();
    removeLive?.();
  });

  await loadExplorerShortcutStatus();

  if (isAuthenticated(state.config)) {
    loadRemoteFolders().catch(() => {});
  } else {
    showWizardIfNeeded();
    openSettingsModal('account');
  }
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
});
