const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, shell, screen, Notification } = require('electron');

const APP_ID = 'com.boltbytes.syncdesktop';
const APP_DISPLAY_NAME = 'BoltBytes Desktop';


try {
  if (typeof app?.setAppUserModelId === 'function') app.setAppUserModelId(APP_ID);
  if (typeof app?.setName === 'function') app.setName(APP_DISPLAY_NAME);
} catch {
  // Best-effort only.
}
async function ensureWindowsToastShortcut() {
  if (process.platform !== 'win32') return;

  try {
    const programsDir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const shortcutPath = path.join(programsDir, `${APP_DISPLAY_NAME}.lnk`);
    const args = app.isPackaged ? '' : `"${app.getAppPath()}"`;

    await fs.mkdir(programsDir, { recursive: true });

    shell.writeShortcutLink(shortcutPath, {
      target: process.execPath,
      cwd: path.dirname(process.execPath),
      args,
      description: APP_DISPLAY_NAME,
      icon: process.execPath,
      appUserModelId: APP_ID,
    });
  } catch {
    // Best-effort only.
  }
}

const crypto = require('node:crypto');


// --- Cloud Files (Windows CFAPI) bridge (MVP) ---
const VFS_PROVIDER_ID = '4f6d0c5e-7c2f-4d9b-a7e0-75b9385c00b2';
let vfsServer = null;
let vfsProviderProcess = null;
let vfsActiveConfig = null;
const vfsSockets = new Set();

let vfsProviderState = {
  running: false,
  lastError: '',
  lastExitCode: null,
  lastEventAt: null,
  launchCmd: '',
};

let vfsProviderStopRequested = false;
let vfsProviderStartedAt = 0;
let vfsProviderRestartAttempts = 0;
let vfsProviderRestartTimer = null;
const vfsProviderRecentLogs = [];

function pushVfsProviderLog(level, text) {
  const line = String(text || '').trim();
  if (!line) return;
  const entry = { at: Date.now(), level, line };
  vfsProviderRecentLogs.push(entry);
  while (vfsProviderRecentLogs.length > 80) vfsProviderRecentLogs.shift();
  vfsProviderState.lastLogLine = line;
  vfsProviderState.lastLogLevel = level;
  vfsProviderState.lastEventAt = Date.now();
  publishVfsStatus();
}


function getVfsStatus() {
  return {
    enabled: Boolean(vfsActiveConfig?.virtualFilesEnabled),
    syncRoot: vfsActiveConfig?.virtualFilesFolder || '',
    remoteFolderId: vfsActiveConfig?.remoteFolderId || '',
    provider: { ...vfsProviderState },
  };
}

function publishVfsStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vfs:status', getVfsStatus());
  }
}

function getVfsPipeName() {
  const base = app.getPath('userData');
  const suffix = crypto.createHash('sha1').update(base).digest('hex').slice(0, 10);
  return `boltbytes-syncdesktop-vfs-${suffix}`;
}

function frameEncode(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function createFrameDecoder(onMessage) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const len = buffer.readUInt32LE(0);
      if (buffer.length < 4 + len) return;
      const body = buffer.subarray(4, 4 + len);
      buffer = buffer.subarray(4 + len);
      try {
        const msg = JSON.parse(body.toString('utf8'));
        onMessage(msg);
      } catch {
        // ignore malformed frame
      }
    }
  };
}

async function handleVfsRequest(req) {
  const id = req?.id ?? null;
  const method = String(req?.method || '');
  const params = req?.params || {};
  if (!id) return null;

  if (method === 'ping') return { id, ok: true, result: 'pong' };

  if (!vfsActiveConfig) {
    return { id, ok: false, error: 'VFS is not configured.' };
  }

  const { client } = await getAuthenticatedClient(vfsActiveConfig);

  if (method === 'tree') {
    const parentId = String(params.parentId ?? vfsActiveConfig.remoteFolderId ?? '');
    const workspaceId = Number(params.workspaceId ?? vfsActiveConfig.workspaceId ?? 0);
    const tree = await client.listRemoteTree({ parentId, workspaceId });
    return { id, ok: true, result: tree };
  }

  if (method === 'downloadRange') {
    const entryId = String(params.entryId || '');
    if (!entryId) return { id, ok: false, error: 'Missing entryId' };

    const offset = Number(params.offset || 0);
    const length = Number(params.length || 0);
    const name = String(params.name || entryId);
    const entry = { id: entryId, name };

    let buf;
    try {
      if (typeof client.downloadFileRange === 'function') {
        buf = await client.downloadFileRange(entry, { offset, length });
      } else {
        buf = await client.downloadFile(entry);
        if (Number.isFinite(offset) && offset > 0) buf = buf.subarray(offset);
        if (Number.isFinite(length) && length > 0) buf = buf.subarray(0, length);
      }
    } catch (err) {
      return { id, ok: false, error: String(err?.message || err) };
    }

    return { id, ok: true, result: { dataBase64: buf.toString('base64'), length: buf.length } };
  }

  return { id, ok: false, error: `Unknown method: ${method}` };
}

async function startVfsServer() {
  if (process.platform !== 'win32') return;
  if (vfsServer) return;

  const pipeName = getVfsPipeName();
  const pipePath = `\\\\.\\pipe\\${pipeName}`;

  vfsServer = net.createServer(socket => {
    vfsSockets.add(socket);
    const decode = createFrameDecoder(async msg => {
      const response = await (async () => {
        try {
          return await handleVfsRequest(msg);
        } catch (err) {
          return { id: msg?.id ?? null, ok: false, error: String(err?.message || err) };
        }
      })();
      if (!response) return;
      try { socket.write(frameEncode(response)); } catch {}
    });

    socket.on('data', decode);
    socket.on('close', () => vfsSockets.delete(socket));
    socket.on('error', () => vfsSockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    vfsServer.once('error', reject);
    vfsServer.listen(pipePath, resolve);
  });
}

async function stopVfsServer() {
  if (!vfsServer) return;
  for (const sock of Array.from(vfsSockets)) {
    try { sock.destroy(); } catch {}
  }
  vfsSockets.clear();
  await new Promise(resolve => vfsServer.close(() => resolve()));
  vfsServer = null;
}

function stopVfsProvider() {
  vfsProviderStopRequested = true;
  if (vfsProviderRestartTimer) { try { clearTimeout(vfsProviderRestartTimer); } catch {} vfsProviderRestartTimer = null; }
  if (vfsProviderProcess) {
    try { vfsProviderProcess.kill(); } catch {}
  }
  vfsProviderProcess = null;
  vfsProviderState.running = false;
  vfsProviderState.lastExitCode = null;
  vfsProviderState.lastEventAt = Date.now();
  publishVfsStatus();
}

function resolveVfsProviderLaunch() {
  const envPath = process.env.BOLTBYTES_VFS_PROVIDER_PATH;
  if (envPath) return { cmd: envPath, args: [] };

  if (!app.isPackaged) {
    // Dev: run via dotnet (requires dotnet SDK).
    const csproj = path.join(app.getAppPath(), 'native', 'windows', 'BoltBytesVfsProvider', 'BoltBytesVfsProvider.csproj');
    return { cmd: 'dotnet', args: ['run', '--project', csproj] };
  }

  // Packaged: allow dropping the exe next to the app resources.
  const candidate = path.join(process.resourcesPath || '', 'BoltBytesVfsProvider.exe');
  return { cmd: candidate, args: [] };
}


async function ensureDirectoryExists(targetPath) {
  const value = String(targetPath || '').trim();
  if (!value) return;

  try {
    const stat = await fs.stat(value);
    if (stat.isDirectory()) return;
    throw new Error(`Path exists but is not a directory: ${value}`);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  await fs.mkdir(value, { recursive: true });
}

async function configureVfsInfrastructure(config) {
  if (process.platform !== 'win32') return;

  const enabled = Boolean(config?.virtualFilesEnabled);
  if (!enabled) {
    vfsActiveConfig = null;
    stopVfsProvider();
    await stopVfsServer();
    return;
  }

  if (!config?.virtualFilesFolder) {
    vfsProviderState.running = false;
    vfsProviderState.lastError = 'Cloud Files is enabled but no Cloud Files folder is selected.';
    vfsProviderState.lastEventAt = Date.now();
    publishVfsStatus();
    addActivity({ level: 'warning', message: 'Cloud Files is enabled but no Cloud Files folder is selected.' });
    return;
  }
  if (!config?.remoteFolderId) {
    vfsProviderState.running = false;
    vfsProviderState.lastError = 'Cloud Files needs a cloud folder selection first.';
    vfsProviderState.lastEventAt = Date.now();
    publishVfsStatus();
    addActivity({ level: 'warning', message: 'Cloud Files needs a cloud folder selection first.' });
    return;
  }

  await ensureDirectoryExists(config.virtualFilesFolder);

  vfsActiveConfig = { ...defaultConfig, ...config };
  await startVfsServer();

  if (vfsProviderProcess) return;

  const pipeName = getVfsPipeName();
  const launch = resolveVfsProviderLaunch();
  vfsProviderState.launchCmd = String(launch.cmd || '');
  vfsProviderState.lastError = '';
  vfsProviderState.lastExitCode = null;
  vfsProviderState.lastEventAt = Date.now();
  publishVfsStatus();
  const args = [
    ...(launch.args || []),
    '--',
    '--syncRoot', config.virtualFilesFolder,
    '--pipeName', pipeName,
    '--remoteFolderId', String(config.remoteFolderId),
    '--workspaceId', String(config.workspaceId ?? 0),
    '--providerId', VFS_PROVIDER_ID,
    '--providerName', APP_DISPLAY_NAME,
  ];

  try {
    vfsProviderStopRequested = false;
    vfsProviderStartedAt = Date.now();
    if (vfsProviderRestartTimer) { try { clearTimeout(vfsProviderRestartTimer); } catch {} vfsProviderRestartTimer = null; }
    vfsProviderProcess = require('node:child_process').spawn(launch.cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    vfsProviderState.running = true;
    vfsProviderState.lastEventAt = Date.now();
    publishVfsStatus();

    vfsProviderProcess.stdout?.on('data', buf => {
      const lines = String(buf).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        addActivity({ level: 'info', message: `[Cloud Files] ${line}` });
        pushVfsProviderLog('info', line);
      }
    });
    vfsProviderProcess.stderr?.on('data', buf => {
      const lines = String(buf).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        addActivity({ level: 'warning', message: `[Cloud Files] ${line}` });
        pushVfsProviderLog('warning', line);
      }
    });
    vfsProviderProcess.on('error', err => {
      const msg = String(err?.message || err);
      const code = String(err?.code || '');
      let friendly = msg;
      if (code === 'ENOENT' && String(vfsProviderState.launchCmd).toLowerCase() === 'dotnet') {
        friendly = '.NET SDK was not found. Install .NET 8 SDK (for development), or build BoltBytesVfsProvider.exe and set BOLTBYTES_VFS_PROVIDER_PATH.';
      }
      addActivity({ level: 'warning', message: `[Cloud Files] Provider error: ${friendly}` });
      vfsProviderState.running = false;
      vfsProviderState.lastError = friendly;
      vfsProviderState.lastExitCode = null;
      vfsProviderState.lastEventAt = Date.now();
      publishVfsStatus();
      vfsProviderProcess = null;
    });

    vfsProviderProcess.on('exit', (code, signal) => {
      const codeLabel = code === null || typeof code === 'undefined' ? 'unknown' : String(code);
      const signalLabel = signal ? String(signal) : '';
      const runtimeMs = vfsProviderStartedAt ? (Date.now() - vfsProviderStartedAt) : 0;

      const requested = Boolean(vfsProviderStopRequested);
      const details = requested
        ? 'requested'
        : `code ${codeLabel}${signalLabel ? `, signal ${signalLabel}` : ''}`;

      addActivity({ level: 'warning', message: `[Cloud Files] Provider stopped (${details})` });

      vfsProviderState.running = false;
      vfsProviderState.lastExitCode = (code === null || typeof code === 'undefined') ? null : code;
      vfsProviderState.lastExitSignal = signalLabel || null;
      vfsProviderState.lastEventAt = Date.now();
      if (!requested && codeLabel !== '0') {
        vfsProviderState.lastError = vfsProviderState.lastError || (vfsProviderState.lastLogLine || 'Provider exited unexpectedly.');
      }
      publishVfsStatus();

      vfsProviderProcess = null;

      // Auto-restart on unexpected stop (best-effort), unless disabled.
      if (!requested && vfsActiveConfig?.virtualFilesEnabled && vfsActiveConfig?.virtualFilesFolder && vfsActiveConfig?.remoteFolderId) {
        if (runtimeMs > 60_000) vfsProviderRestartAttempts = 0;
        vfsProviderRestartAttempts = Math.min(vfsProviderRestartAttempts + 1, 6);
        const delayMs = Math.min(30_000, 1500 * (2 ** vfsProviderRestartAttempts));
        if (vfsProviderRestartTimer) { try { clearTimeout(vfsProviderRestartTimer); } catch {} }
        vfsProviderRestartTimer = setTimeout(() => {
          vfsProviderRestartTimer = null;
          configureVfsInfrastructure(vfsActiveConfig).catch(err => {
            addActivity({ level: 'warning', message: `[Cloud Files] Auto-restart failed: ${String(err?.message || err)}` });
          });
        }, delayMs);
        addActivity({ level: 'info', message: `[Cloud Files] Auto-restart scheduled in ${Math.round(delayMs / 1000)}s.` });
      }
    });
  } catch (err) {
    const msg = String(err?.message || err);
    addActivity({ level: 'warning', message: `[Cloud Files] Failed to start provider: ${msg}` });
    vfsProviderState.running = false;
    vfsProviderState.lastError = msg;
    vfsProviderState.lastExitCode = null;
    vfsProviderState.lastEventAt = Date.now();
    publishVfsStatus();
  }
}

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readFileSync } = require('node:fs');
const { runSync } = require('./sync-engine');
const { BoltBytesClient } = require('./api-client');


function enableDevToolsShortcuts(win) {
  if (!win || win.isDestroyed()) return;
  if (app.isPackaged) return;

  const toggle = () => {
    try {
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      else win.webContents.openDevTools({ mode: 'detach' });
    } catch {
      // Best-effort
    }
  };

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    const isF12 = input.key === 'F12';
    const isCtrlShiftI = (input.key || '').toUpperCase() === 'I' && input.control && input.shift;

    if (isF12 || isCtrlShiftI) {
      event.preventDefault();
      toggle();
    }
  });

  // Auto-open DevTools in dev if requested.
  if (process.env.BOLTBYTES_OPEN_DEVTOOLS === '1') {
    win.once('ready-to-show', () => toggle());
  }
}

let mainWindow;
let tray;
let currentStatus = 'Ready';
let latestSyncResult = null;
let syncInProgress = false;

const activeTransfers = new Map();

function sendLiveUpdate(extra = {}) {
  if (!mainWindow) return;
  try {
    const pendingOpsCount = Array.isArray(extra.pendingOps)
      ? extra.pendingOps.length
      : (Array.isArray(latestSyncResult?.pendingOps) ? latestSyncResult.pendingOps.length : 0);

    mainWindow.webContents.send('sync:live', {
      ts: new Date().toISOString(),
      status: currentStatus,
      syncInProgress,
      completed: latestSyncResult?.completedOperations || 0,
      total: latestSyncResult?.totalOperations || 0,
      live: latestSyncResult?.live || { uploading: 0, downloading: 0, conflicts: 0 },
      active: Array.from(activeTransfers.values()).slice(0, 12),
      pendingOpsCount,
      ...extra,
    });
  } catch {}
}
const activityLog = [];
const MAX_ACTIVITY_ITEMS = 200;
const WINDOW_WIDTH = 388;
const WINDOW_HEIGHT = 660;
let autoSyncTimeout = null;
let remotePollTimer = null;
let localWatcher = null;
let ignoreLocalWatcherEventsUntil = 0;

const recentLocalDeletes = new Map();
const RECENT_LOCAL_DELETE_TTL_MS = 2 * 60 * 1000;

function normalizeRelativePath(value) {
  return String(value || '').split(path.sep).join('/').replace(/^\/+/, '');
}

function pruneRecentLocalDeletes() {
  const now = Date.now();
  for (const [key, ts] of recentLocalDeletes.entries()) {
    if (now - ts > RECENT_LOCAL_DELETE_TTL_MS) recentLocalDeletes.delete(key);
  }
}

function recordRecentLocalDelete(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return;
  recentLocalDeletes.set(normalized, Date.now());
  pruneRecentLocalDeletes();
}

const pendingConflicts = new Map();
let conflictQueue = Promise.resolve();

const conflictDecisionByKind = new Map();
let activeSyncConfig = null;


const execFileAsync = promisify(execFile);

let wifiCache = { checkedAt: 0, value: null, error: '' };
const WIFI_CACHE_TTL_MS = 15000;

async function isConnectedToWifi() {
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    const now = Date.now();
    if (wifiCache.value !== null && now - wifiCache.checkedAt < WIFI_CACHE_TTL_MS) {
      return wifiCache.value;
    }
    try {
      let connected = false;
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('netsh', ['wlan', 'show', 'interfaces'], { windowsHide: true });
        connected = /\bState\s*:\s*connected\b/i.test(stdout) || /\bStatus\s*:\s*connected\b/i.test(stdout);
      } else if (process.platform === 'darwin') {
        const candidates = ['en0', 'en1'];
        for (const device of candidates) {
          try {
            const { stdout } = await execFileAsync('/usr/sbin/networksetup', ['-getairportnetwork', device]);
            if (/Current Wi-Fi Network:\s*(?!.*not associated)/i.test(stdout) && !/not associated/i.test(stdout)) {
              connected = true;
              break;
            }
          } catch {}
        }
      } else {
        try {
          const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'TYPE,STATE', 'dev']);
          connected = stdout.split(/\r?\n/).some(line => /^wifi:connected$/i.test(line.trim()));
        } catch {
          try {
            const { stdout } = await execFileAsync('iwgetid', ['-r']);
            connected = Boolean(String(stdout || '').trim());
          } catch {
            connected = false;
          }
        }
      }

      wifiCache = { checkedAt: now, value: connected, error: '' };
      return connected;
    } catch (error) {
      wifiCache = { checkedAt: now, value: false, error: String(error?.message || error) };
      return false;
    }
  }
  return false;
}

async function checkSyncGate(config) {
  if (config?.syncPaused) {
    return { ok: false, reason: 'Sync is paused.', statusText: 'Paused' };
  }
  if (config?.wifiOnly) {
    const onWifi = await isConnectedToWifi();
    if (!onWifi) {
      return { ok: false, reason: 'Wi-Fi only is enabled. Waiting for Wi-Fi.', statusText: 'Waiting for Wi-Fi' };
    }
  }
  return { ok: true, reason: '', statusText: '' };
}

const defaultConfig = {
  baseUrl: 'https://boltbytes.com',
  token: '',
  email: '',
  password: '',
  rememberPassword: true,
  user: null,
  localFolder: '',
  backendId: '',
  remoteFolderId: '',
  remoteFolderName: '',
  lastSyncContext: {
    localFolder: '',
    remoteFolderName: '',
    finishedAt: '',
  },
  uploadType: 'bedrive',
  autoSyncEnabled: true,
  syncPaused: false,
  wifiOnly: false,
  ignoreRulesText: 'Thumbs.db\n.DS_Store\n*.tmp\n~$*\n',
  selectiveSyncExcludedFolders: [],
  conflictStrategy: 'ask',
  moveLocalDeletesToTrash: true,
  enableDownloadSync: true,
  explorerShortcutName: 'BoltBytes Sync',
  autoCreateExplorerShortcut: true,
  launchOnStartup: false,
  showNotifications: true,
  pollIntervalSeconds: 30,
  syncConcurrency: 3,
  debugApi: false,
};

function getConfigPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function maskSecret(secret) {
  return secret ? '••••••••' : '';
}



function getNotificationIcon() {
  const candidate = process.platform === 'win32'
    ? path.join(__dirname, 'assets', 'boltbytes-app.ico')
    : path.join(__dirname, 'assets', 'boltbytes-icon.svg');
  try {
    return nativeImage.createFromPath(candidate);
  } catch {
    return null;
  }
}

function showDesktopNotification(config, title, body) {
  if (!config?.showNotifications) return;
  try {
    if (typeof Notification?.isSupported === 'function' && !Notification.isSupported()) return;
    const icon = getNotificationIcon();
    new Notification({
      title: title || APP_DISPLAY_NAME,
      body: body || '',
      icon: icon || undefined,
    }).show();
  } catch {
    // Notifications are best-effort.
  }
}


function serializeConfigForRenderer(config) {
  const safe = { ...config, baseUrl: defaultConfig.baseUrl };
  const serverHost = (() => {
    try { return new URL(defaultConfig.baseUrl).host; } catch { return 'boltbytes.com'; }
  })();

  const { baseUrl, ...rest } = safe;

  return {
    ...rest,
    serverHost,
    password: safe.rememberPassword ? safe.password : '',
    tokenMasked: maskSecret(safe.token),
    isLoggedIn: Boolean(safe.token),
  };
}


function createApiDebugEmitter(config) {
  if (!mainWindow || !config?.debugApi) return null;
  return payload => {
    try {
      mainWindow.webContents.send('debug:api', {
        ts: new Date().toISOString(),
        ...payload,
      });
    } catch {
      // Best-effort logging only.
    }
  };
}

function createClient(config) {
  return new BoltBytesClient({
    baseUrl: config.baseUrl,
    token: config.token,
    debug: createApiDebugEmitter(config),
  });
}



function getDefaultVirtualFilesFolder() {
  try {
    const home = app.getPath('home') || app.getPath('userData');
    return path.join(home, 'BoltBytes Cloud Files');
  } catch {
    return '';
  }

}

function getDefaultCacheRoot() {
  try {
    if (process.platform === 'win32') {
      const base = process.env.LOCALAPPDATA || app.getPath('userData');
      return path.join(base, 'BoltBytes Desktop', 'Cache');
    }
    return path.join(app.getPath('userData'), 'Cache');
  } catch {
    return '';
  }
}

function getCacheRoot() {
  return getDefaultCacheRoot();
}

async function ensureDir(dirPath) {
  if (!dirPath) return;
  await fs.mkdir(dirPath, { recursive: true });
}

async function listFilesRecursive(rootDir) {
  const out = [];
  async function walk(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  if (rootDir) await walk(rootDir);
  return out;
}

let lastCacheCleanup = null;

async function getCacheInfo() {
  const rootDir = getCacheRoot();
  const files = await listFilesRecursive(rootDir);
  let sizeBytes = 0;
  for (const f of files) {
    try {
      const st = await fs.stat(f);
      sizeBytes += Number(st.size || 0);
    } catch {
      // ignore
    }
  }
  return { root: rootDir, sizeBytes, fileCount: files.length, lastCleanup: lastCacheCleanup };
}

async function cleanupCache(config) {
  const cfg = applyConfigDefaults(config || {});
  if (cfg.cacheAutoClean === false) return { deletedFiles: 0, freedBytes: 0 };

  const rootDir = getCacheRoot();
  if (!rootDir) return { deletedFiles: 0, freedBytes: 0 };

  await ensureDir(rootDir);

  const maxAgeDays = Math.max(1, Math.floor(Number(cfg.cacheMaxAgeDays || 7)));
  const maxSizeBytes = Math.max(50, Math.floor(Number(cfg.cacheMaxSizeMb || 1024))) * 1024 * 1024;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  const files = await listFilesRecursive(rootDir);
  const metas = [];

  for (const f of files) {
    try {
      const st = await fs.stat(f);
      metas.push({ path: f, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0) });
    } catch {
      // ignore
    }
  }

  let deletedFiles = 0;
  let freedBytes = 0;

  // Age-based cleanup first.
  for (const m of metas) {
    if (m.mtimeMs && m.mtimeMs < cutoff) {
      try {
        await fs.unlink(m.path);
        deletedFiles += 1;
        freedBytes += m.size;
      } catch {
        // ignore busy/permissions
      }
    }
  }

  // Size-based cleanup next (oldest first).
  const remaining = [];
  let totalSize = 0;
  for (const m of metas) {
    try {
      const st = await fs.stat(m.path);
      remaining.push({ path: m.path, mtimeMs: Number(st.mtimeMs || 0), size: Number(st.size || 0) });
      totalSize += Number(st.size || 0);
    } catch {
      // already deleted
    }
  }

  if (totalSize > maxSizeBytes) {
    remaining.sort((a, b) => (a.mtimeMs || 0) - (b.mtimeMs || 0));
    for (const m of remaining) {
      if (totalSize <= maxSizeBytes) break;
      try {
        await fs.unlink(m.path);
        deletedFiles += 1;
        freedBytes += m.size;
        totalSize -= m.size;
      } catch {
        // ignore
      }
    }
  }

  // Best-effort: remove empty directories.
  async function prune(dir) {
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) await prune(path.join(dir, ent.name));
    }
    try {
      const after = await fs.readdir(dir);
      if (after.length === 0) await fs.rmdir(dir);
    } catch {
      // ignore
    }
  }
  await prune(rootDir);

  return { deletedFiles, freedBytes };
}

let cacheCleanupTimer = null;

async function scheduleCacheMaintenance(config) {
  const cfg = applyConfigDefaults(config || {});
  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer);
    cacheCleanupTimer = null;
  }

  if (cfg.cacheAutoClean === false) return;

  try {
    const before = await getCacheInfo();
    const cleanup = await cleanupCache(cfg);
    const after = await getCacheInfo();
    lastCacheCleanup = {
      ranAt: Date.now(),
      source: 'auto',
      deletedFiles: Number(cleanup?.deletedFiles || 0),
      freedBytes: Number(cleanup?.freedBytes || 0),
      before,
      after,
    };
  } catch {
    // Best-effort.
  }

  cacheCleanupTimer = setInterval(async () => {
    try {
      const before = await getCacheInfo();
      const cleanup = await cleanupCache(cfg);
      const after = await getCacheInfo();
      lastCacheCleanup = {
        ranAt: Date.now(),
        source: 'auto',
        deletedFiles: Number(cleanup?.deletedFiles || 0),
        freedBytes: Number(cleanup?.freedBytes || 0),
        before,
        after,
      };
    } catch {
      // Best-effort.
    }
  }, 6 * 60 * 60 * 1000);
}

function applyConfigDefaults(config) {
  const cfg = { ...config };

  if (typeof cfg.virtualFilesEnabled !== 'boolean') cfg.virtualFilesEnabled = false;
  if (typeof cfg.virtualFilesFolderUnlocked !== 'boolean') cfg.virtualFilesFolderUnlocked = false;

  const defVfs = getDefaultVirtualFilesFolder();
  if (!cfg.virtualFilesFolderUnlocked) {
    cfg.virtualFilesFolder = defVfs;
  } else if (!cfg.virtualFilesFolder) {
    cfg.virtualFilesFolder = defVfs;
  }

  if (typeof cfg.cacheAutoClean !== 'boolean') cfg.cacheAutoClean = true;

  const age = Number(cfg.cacheMaxAgeDays);
  cfg.cacheMaxAgeDays = Number.isFinite(age) ? Math.max(1, Math.floor(age)) : 7;

  const size = Number(cfg.cacheMaxSizeMb);
  cfg.cacheMaxSizeMb = Number.isFinite(size) ? Math.max(50, Math.floor(size)) : 1024;

  return cfg;
}

async function loadConfig() {
  

  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return applyConfigDefaults({ ...defaultConfig, ...parsed, baseUrl: defaultConfig.baseUrl });
  } catch {
    return applyConfigDefaults({ ...defaultConfig });
  }
}

async function saveConfig(config) {
  const existing = await loadConfig();
  const merged = { ...defaultConfig, ...existing, ...config };
  merged.baseUrl = defaultConfig.baseUrl;

  const normalized = applyConfigDefaults(merged);

  if (!normalized.rememberPassword) {
    normalized.password = '';
  }
  delete normalized.parentId;

  await fs.mkdir(path.dirname(getConfigPath()), { recursive: true });
  await fs.writeFile(getConfigPath(), JSON.stringify(normalized, null, 2));

  await ensureSyncFolderIcon(normalized);
  await configureAutoSyncInfrastructure(normalized);
  await configureVfsInfrastructure(normalized);
  await scheduleCacheMaintenance(normalized);

  return normalized;
}


function canAutoSync(config) {
  return Boolean(config?.autoSyncEnabled !== false && !config?.syncPaused && config?.baseUrl && config?.token && config?.localFolder && config?.remoteFolderId);
}

async function stopAutoSyncInfrastructure() {
  if (autoSyncTimeout) {
    clearTimeout(autoSyncTimeout);
    autoSyncTimeout = null;
  }
  if (remotePollTimer) {
    clearInterval(remotePollTimer);
    remotePollTimer = null;
  }
  if (localWatcher) {
    localWatcher.close();
    localWatcher = null;
  }
  stopVfsProvider();
  await stopVfsServer();
}

async function triggerAutoSync(reason = 'Changes detected') {
  const config = await loadConfig();
  if (!canAutoSync(config) || syncInProgress) return;
  const gate = await checkSyncGate(config);
  if (!gate.ok) {
    setStatus(gate.statusText);
    addActivity({ level: 'info', message: gate.reason });
    return;
  }
  addActivity({ level: 'info', message: `${reason} — starting automatic sync` });
  try {
    await performSync(config);
  } catch (error) {
    addActivity({ level: 'warning', message: `Automatic sync failed: ${error.message}` });
  }
}

function scheduleAutoSync(reason, delayMs = 1200) {
  if (autoSyncTimeout) {
    clearTimeout(autoSyncTimeout);
  }
  autoSyncTimeout = setTimeout(() => {
    autoSyncTimeout = null;
    triggerAutoSync(reason);
  }, delayMs);
}

async function configureAutoSyncInfrastructure(config) {
  await stopAutoSyncInfrastructure();
  if (!canAutoSync(config)) {
    return;
  }

  try {
    ignoreLocalWatcherEventsUntil = Date.now() + 5000;
    localWatcher = require('node:fs').watch(config.localFolder, { recursive: true }, (eventType, filename) => {
      if (Date.now() < ignoreLocalWatcherEventsUntil) return;
      if (filename) {
        const rel = normalizeRelativePath(filename.toString());
        const abs = path.join(config.localFolder, rel);
        setTimeout(async () => {
          try {
            await fs.access(abs);
          } catch {
            recordRecentLocalDelete(rel);
          }
        }, 250);
      }
      scheduleAutoSync('Local file changed');
    });
  } catch {
    addActivity({ level: 'warning', message: 'Real-time local watching is not fully supported on this platform; using polling instead.' });
  }

  const intervalMs = Math.max(Number(config.pollIntervalSeconds || 30), 10) * 1000;
  remotePollTimer = setInterval(() => {
    scheduleAutoSync('Background cloud check', 10);
  }, intervalMs);
}


function getSyncStateFilePath(config) {
  if (!config?.localFolder) return null;
  const key = crypto.createHash('sha1').update(`${String(config.localFolder)}|${String(config.remoteFolderId || '')}|${String(config.baseUrl || '')}|${String(config.workspaceId ?? 0)}`).digest('hex');
  return path.join(app.getPath('userData'), 'sync-state', `${key}.json`);
}

async function ensureSyncFolderIcon(config) {
  if (process.platform !== 'win32' || !config?.localFolder) return;
  try {
    const folderIconName = '.boltbytes-folder.ico';
    const folderIconPath = path.join(config.localFolder, folderIconName);
    const desktopIniPath = path.join(config.localFolder, 'desktop.ini');
    const sourceIconPath = path.join(__dirname, 'assets', 'boltbytes-folder.ico');
    try {
      await fs.access(folderIconPath);
    } catch {
      await fs.copyFile(sourceIconPath, folderIconPath);
    }
    await fs.writeFile(desktopIniPath, `[.ShellClassInfo]
IconResource=${folderIconName},0
[ViewState]
Mode=
Vid=
FolderType=Generic
`, 'utf8');
    try {
      await execFileAsync('attrib', ['+h', '+s', folderIconPath]);
      await execFileAsync('attrib', ['+h', '+s', desktopIniPath]);
      await execFileAsync('attrib', ['+s', config.localFolder]);
    } catch {}
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') return;
    addActivity({ level: 'warning', message: `Could not apply the sync folder icon: ${error.message}` });
  }
}

async function loadPersistedSyncStates(config) {
  const filePath = getSyncStateFilePath(config);
  if (!filePath) return { entries: {}, pendingOps: [] };

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const legacyEntries = parsed.entries || parsed || {};
    const opaqueKeyPattern = /^\d+$|^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const cleanedEntries = Object.fromEntries(
      Object.entries(legacyEntries).filter(([key]) => key !== '.boltbytes-sync-state.json' && !opaqueKeyPattern.test(key)),
    );

    const pendingOps = Array.isArray(parsed.pendingOps) ? parsed.pendingOps : [];
    return { entries: cleanedEntries, pendingOps };
  } catch {
    return { entries: {}, pendingOps: [] };
  }
}

async function savePersistedSyncStates(config, entries, pendingOps = []) {
  const filePath = getSyncStateFilePath(config);
  if (!filePath) return;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    entries: entries || {},
    pendingOps: Array.isArray(pendingOps) ? pendingOps : [],
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
}


function getAppIconPath() {
  return path.join(__dirname, 'assets', process.platform === 'win32' ? 'boltbytes-app.ico' : 'boltbytes-icon.svg');
}

function createTrayIcon() {
  const iconPath = getAppIconPath();
  if (iconPath.endsWith('.ico')) return nativeImage.createFromPath(iconPath);
  const svg = readFileSync(iconPath, 'utf8');
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function addActivity(entry) {
  const item = {
    id: Date.now() + Math.random(),
    at: new Date().toISOString(),
    ...entry,
  };
  activityLog.unshift(item);
  if (activityLog.length > MAX_ACTIVITY_ITEMS) {
    activityLog.length = MAX_ACTIVITY_ITEMS;
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('activity:push', item);
  }

  updateTrayMenu();
}

function setStatus(status) {
  currentStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status:update', { status, syncInProgress, latestSyncResult });
  }
  if (tray) {
    tray.setToolTip(`BoltBytes Sync\n${status}`);
  }
  updateTrayMenu();
}

function updateProgressBar(completed, total) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (completed === -1) {
    mainWindow.setProgressBar(-1);
    return;
  }
  if (!total) {
    mainWindow.setProgressBar(0);
    return;
  }
  mainWindow.setProgressBar(completed / total);
}

function positionWindow() {
  if (!mainWindow) return;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const workArea = display.workArea;
  const x = Math.round(workArea.x + workArea.width - WINDOW_WIDTH - 20);
  const y = Math.round(workArea.y + workArea.height - WINDOW_HEIGHT - 20);
  mainWindow.setBounds({ x, y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
}

async function runSyncFromTray() {
  const config = await loadConfig();
  if (!config.token) {
    showWindow();
    setStatus('Sign in before syncing');
    return;
  }

  try {
    await performSync(config);
  } catch {
    showWindow();
  }
}

function updateTrayMenu() {
  if (!tray) return;

  const recentItems = activityLog.slice(0, 5).map(item => ({
    label: `${item.message}`.slice(0, 72),
    enabled: false,
  }));

  const template = [
    { label: `Status: ${currentStatus}`, enabled: false },
    { type: 'separator' },
    { label: 'Open sync panel', click: () => showWindow() },
    { label: 'Sync now', click: () => runSyncFromTray() },
    {
      label: (activeSyncConfig?.syncPaused ? 'Resume syncing' : 'Pause syncing'),
      click: async () => {
        const config = await loadConfig();
        const next = { ...config, syncPaused: !config.syncPaused };
        await saveConfig(next);
        setStatus(next.syncPaused ? 'Paused' : 'Ready');
        addActivity({ level: 'info', message: next.syncPaused ? 'Sync paused' : 'Sync resumed' });
        updateTrayMenu();
        sendLiveUpdate();
      },
    },
    {
      label: 'Open synced folder',
      click: async () => {
        const config = await loadConfig();
        if (config.localFolder) shell.openPath(config.localFolder);
      },
    },
    { type: 'separator' },
    { label: 'Recent activity', enabled: false },
    ...recentItems,
    ...(recentItems.length ? [{ type: 'separator' }] : []),
    { label: 'Quit', click: () => app.quit() },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function showWindow() {
  if (!mainWindow) return;
  positionWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function getLinksFolder() {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return null;
  return path.join(userProfile, 'Links');
}

function getExplorerShortcutPath(config) {
  const linksFolder = getLinksFolder();
  if (!linksFolder) return null;
  const name = (config.explorerShortcutName || 'BoltBytes Sync').trim() || 'BoltBytes Sync';
  return path.join(linksFolder, `${name}.lnk`);
}

async function getExplorerShortcutStatus(config) {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      exists: false,
      shortcutPath: null,
      message: 'The Explorer shortcut is only implemented automatically on Windows.',
    };
  }

  const shortcutPath = getExplorerShortcutPath(config);
  if (!shortcutPath) {
    return {
      supported: true,
      exists: false,
      shortcutPath: null,
      message: 'Could not find the Windows Links folder.',
    };
  }

  try {
    await fs.access(shortcutPath);
    return {
      supported: true,
      exists: true,
      shortcutPath,
      message: `Explorer shortcut already exists: ${shortcutPath}`,
    };
  } catch {
    return {
      supported: true,
      exists: false,
      shortcutPath,
      message: config.localFolder
        ? 'No Explorer shortcut yet. Click "Create shortcut" to place the folder in the sidebar/favorites.'
        : 'Choose a local folder before creating an Explorer shortcut.',
    };
  }
}

async function createExplorerShortcut(config) {
  if (!config.localFolder) {
    throw new Error('Choose a local folder before creating the shortcut.');
  }

  if (process.platform !== 'win32') {
    return {
      supported: false,
      exists: false,
      shortcutPath: null,
      message: 'The Explorer shortcut is only implemented automatically on Windows.',
    };
  }

  const linksFolder = getLinksFolder();
  if (!linksFolder) {
    throw new Error('Could not find the Windows Links folder.');
  }

  await fs.mkdir(linksFolder, { recursive: true });
  const shortcutPath = getExplorerShortcutPath(config);
  const success = shell.writeShortcutLink(shortcutPath, 'create', {
    target: config.localFolder,
    cwd: config.localFolder,
    description: 'BoltBytes Desktop folder',
    icon: getAppIconPath(),
    iconIndex: 0,
  });

  if (!success) {
    throw new Error('Windows could not create the shortcut.');
  }

  addActivity({ level: 'info', message: `Explorer shortcut created: ${shortcutPath}` });
  return getExplorerShortcutStatus(config);
}

async function removeExplorerShortcut(config) {
  if (process.platform !== 'win32') {
    return {
      supported: false,
      exists: false,
      shortcutPath: null,
      message: 'The Explorer shortcut is only implemented automatically on Windows.',
    };
  }

  const shortcutPath = getExplorerShortcutPath(config);
  if (shortcutPath) {
    await fs.rm(shortcutPath, { force: true });
  }

  addActivity({ level: 'info', message: 'Explorer shortcut removed' });
  return getExplorerShortcutStatus(config);
}

async function loginWithPassword(config) {
  const normalizedConfig = {
    ...defaultConfig,
    ...config,
    baseUrl: defaultConfig.baseUrl,
    email: String(config?.email || '').trim(),
    password: String(config?.password || ''),
  };

  if (normalizedConfig.token && (!normalizedConfig.email || !normalizedConfig.password)) {
    return saveConfig(normalizedConfig);
  }

  if (!normalizedConfig.email || !normalizedConfig.password) {
    throw new Error('Enter your email and password to sign in.');
  }

  const client = createClient(normalizedConfig);
  const session = await client.login({
    email: normalizedConfig.email,
    password: normalizedConfig.password,
    tokenName: APP_DISPLAY_NAME,
  });

  const nextConfig = await saveConfig({
    ...normalizedConfig,
    token: session.token,
    user: session.user,
  });

  addActivity({
    level: 'success',
    message: `Signed in as ${session.user?.display_name || session.user?.name || normalizedConfig.email}`,
  });
  setStatus('Connected');
  return nextConfig;
}

async function ensureAuthenticated(config) {
  if (config.token) {
    return config;
  }
  if (config.email && config.password) {
    return loginWithPassword(config);
  }
  throw new Error('Sign in before syncing.');
}

async function performSync(config) {
  if (syncInProgress) {
    throw new Error('A sync is already running.');
  }

  const gate = await checkSyncGate(config);
  if (!gate.ok) {
    setStatus(gate.statusText);
    addActivity({ level: 'info', message: gate.reason });
    return { skipped: [], warnings: [gate.reason], uploaded: [], downloaded: [], conflicts: [], pendingOps: [] };
  }

  const authenticatedConfig = await ensureAuthenticated(config);
  const suppressUploads = Boolean(authenticatedConfig.lastSyncedRemoteFolderId && authenticatedConfig.lastSyncedRemoteFolderId !== authenticatedConfig.remoteFolderId);
  if (suppressUploads && authenticatedConfig.enableUploadSync) {
    addActivity({ level: 'warning', message: 'Cloud folder changed since last sync — uploads are disabled for this run to prevent copying old local data into the new folder.' });
  }
  const effectiveConfig = { ...authenticatedConfig, suppressUploadsThisRun: suppressUploads };
  const persistedStatePayload = await loadPersistedSyncStates(effectiveConfig);
  const syncStateEntries = persistedStatePayload.entries || {};
  const pendingOps = Array.isArray(persistedStatePayload.pendingOps) ? persistedStatePayload.pendingOps : [];

  syncInProgress = true;
  latestSyncResult = { uploaded: [], downloaded: [], warnings: [], conflicts: [], skipped: [], localCount: 0, remoteCount: 0, completedOperations: 0, totalOperations: 0, live: { uploading: 0, downloading: 0, conflicts: 0 } };
  setStatus('Syncing…');
  updateProgressBar(0, 1);
  addActivity({ level: 'info', message: 'Sync started' });
  sendLiveUpdate({ pendingOps });

  conflictDecisionByKind.clear();
  activeSyncConfig = effectiveConfig;

  if (effectiveConfig.autoCreateExplorerShortcut) {
    try {
      await createExplorerShortcut(effectiveConfig);
    } catch (error) {
      addActivity({ level: 'warning', message: `Could not create the Explorer shortcut automatically: ${error.message}` });
    }
  }

  try {
    const result = await runSync(effectiveConfig, {
      pendingOps,
      recentLocalDeletes: Array.from(recentLocalDeletes.keys()),

      onConflict: resolveConflictWithQueue,
      moveToTrash: async filePath => {
        await shell.trashItem(filePath);
      },
      apiDebug: createApiDebugEmitter(effectiveConfig),
      persistedState: persistedStatePayload,
      onEvent: async event => {
        if (event.type === 'status') {
          if (typeof event.localCount === 'number') latestSyncResult.localCount = event.localCount;
          if (typeof event.remoteCount === 'number') latestSyncResult.remoteCount = event.remoteCount;
          setStatus(event.message);
          addActivity({ level: 'info', message: event.message });
        }

        if (event.type === 'activity') {
          addActivity({ level: event.level || 'info', message: event.message, path: event.path, action: event.action });
          if (event.path && event.action) {
            const activeActions = new Set(['uploading', 'downloading', 'deleting-remote', 'deleting-local']);
            if (activeActions.has(event.action)) {
              activeTransfers.set(event.path, { path: event.path, action: event.action, startedAt: new Date().toISOString() });
              sendLiveUpdate({ pendingOps });
            }
          }

          if (event.path) {
            const actionToState = { uploading: 'uploading', downloading: 'downloading', warning: 'error' };
            syncStateEntries[event.path] = { ...(syncStateEntries[event.path] || {}), state: actionToState[event.action] || 'pending', updatedAt: new Date().toISOString() };
            savePersistedSyncStates(effectiveConfig, syncStateEntries, pendingOps);
          }
        }

        if (event.type === 'queue') {
          if (event.op) {
            pendingOps.push(event.op);
            await savePersistedSyncStates(effectiveConfig, syncStateEntries, pendingOps);
            sendLiveUpdate({ pendingOps });
          }
        }

        if (event.type === 'queue-state') {
          if (Array.isArray(event.pendingOps)) {
            pendingOps.length = 0;
            pendingOps.push(...event.pendingOps);
            await savePersistedSyncStates(effectiveConfig, syncStateEntries, pendingOps);
            sendLiveUpdate({ pendingOps });
          }
        }

        if (event.type === 'progress') {
          if (event.path) {
            const doneActions = new Set(['uploaded','downloaded','deleted-remote','deleted-local','skip-upload','skip-download','skip-download-unavailable','skip-download-disabled','skip-unchanged','skip-missing','conflict','warning','queued-upload','queued-delete']);
            if (doneActions.has(event.action)) {
              activeTransfers.delete(event.path);
            }
          }

          latestSyncResult.completedOperations = event.completed;
          latestSyncResult.totalOperations = event.total;
          latestSyncResult.live = event.live || latestSyncResult.live || { uploading: 0, downloading: 0, conflicts: 0 };
          if (event.action === 'uploaded' && event.path) {
            latestSyncResult.uploaded = [...new Set([...latestSyncResult.uploaded, event.path])];
            syncStateEntries[event.path] = { ...(syncStateEntries[event.path] || {}), state: 'synced', updatedAt: new Date().toISOString() };
          }
          if (event.action === 'downloaded' && event.path) {
            latestSyncResult.downloaded = [...new Set([...latestSyncResult.downloaded, event.path])];
            syncStateEntries[event.path] = { ...(syncStateEntries[event.path] || {}), state: 'synced', updatedAt: new Date().toISOString() };
          }
          if (event.action === 'warning' && event.message) latestSyncResult.warnings = [...latestSyncResult.warnings, event.message];
          if (event.action === 'conflict' && event.path) latestSyncResult.conflicts = [...new Set([...(latestSyncResult.conflicts || []), event.path])];
          if (event.action === 'warning' && event.path) {
            syncStateEntries[event.path] = { ...(syncStateEntries[event.path] || {}), state: 'error', updatedAt: new Date().toISOString(), message: event.message };
          }
          if ((event.action === 'skip-upload' || event.action === 'skip-download' || event.action === 'skip-download-unavailable' || event.action === 'skip-download-disabled' || event.action === 'skip-unchanged' || event.action === 'skip-missing') && event.path) {
            latestSyncResult.skipped = [...new Set([...latestSyncResult.skipped, event.path])];
            syncStateEntries[event.path] = { ...(syncStateEntries[event.path] || {}), state: 'synced', updatedAt: new Date().toISOString() };
          }
          savePersistedSyncStates(effectiveConfig, syncStateEntries, pendingOps);
          updateProgressBar(event.completed, event.total);
          sendLiveUpdate({ pendingOps });
          setStatus(event.message || `Syncing ${event.completed}/${event.total}`);
        }
      },
    });

    latestSyncResult = result;
    await savePersistedSyncStates(effectiveConfig, result.syncStateEntries || syncStateEntries, Array.isArray(result.pendingOps) ? result.pendingOps : pendingOps);
    await saveConfig({
      ...(await loadConfig()),
      lastSyncContext: {
        localFolder: authenticatedConfig.localFolder,
        remoteFolderName: authenticatedConfig.remoteFolderName || 'Root folder',
        remoteFolderId: effectiveConfig.remoteFolderId,
        finishedAt: result.finishedAt || new Date().toISOString(),
      },
      lastSyncedRemoteFolderId: effectiveConfig.remoteFolderId,
    });
    syncInProgress = false;
    activeTransfers.clear();
    sendLiveUpdate({ pendingOps: Array.isArray(result.pendingOps) ? result.pendingOps : pendingOps });
    updateProgressBar(-1, 0);
    const summaryParts = [];
    const uploadedCount = Array.isArray(result.uploaded) ? result.uploaded.length : 0;
    const downloadedCount = Array.isArray(result.downloaded) ? result.downloaded.length : 0;
    const foldersCreatedCount = Array.isArray(result.foldersCreated) ? result.foldersCreated.length : 0;
    const conflictsCount = Array.isArray(result.conflicts) ? result.conflicts.length : 0;
    const warningsCount = Array.isArray(result.warnings) ? result.warnings.length : 0;

    if (uploadedCount) summaryParts.push(`${uploadedCount} uploaded`);
    if (downloadedCount) summaryParts.push(`${downloadedCount} downloaded`);
    if (foldersCreatedCount) summaryParts.push(`${foldersCreatedCount} folder(s) created`);
    if (conflictsCount) summaryParts.push(`${conflictsCount} conflict(s)`);
    if (warningsCount) summaryParts.push(`${warningsCount} warning(s)`);

    const summary = summaryParts.length ? summaryParts.join(', ') : 'No changes';
    const hasMeaningfulChanges = uploadedCount + downloadedCount + foldersCreatedCount + conflictsCount + warningsCount > 0;
    const remoteFilesCount = Number(result.remoteFilesCount ?? result.remoteCount ?? 0);
    const remoteFoldersCount = Number(result.remoteFoldersCount ?? 0);
    const countsHint = summary === 'No changes'
      ? ` (remote files: ${remoteFilesCount}, remote folders: ${remoteFoldersCount}, local: ${Number(result.localCount || 0)})`
      : '';
    setStatus(`Last sync: ${summary}${countsHint}`);

    if (hasMeaningfulChanges) {
      showDesktopNotification(authenticatedConfig, APP_DISPLAY_NAME, `Sync finished: ${summary}`);
    }

    addActivity({ level: 'success', message: 'Sync completed' });
    activeSyncConfig = null;
    return result;
  } catch (error) {
    syncInProgress = false;
    activeTransfers.clear();
    sendLiveUpdate({ pendingOps: Array.isArray(result.pendingOps) ? result.pendingOps : pendingOps });
    updateProgressBar(-1, 0);
    setStatus('Sync failed');
    addActivity({ level: 'error', message: `Sync failed: ${error.message}` });
    activeSyncConfig = null;
    throw error;
  }
}


function toSafeConflictPayload(payload, config) {
  if (!payload) return null;

  const kind = payload.kind || 'both-changed';
  const relativePath = payload.relativePath || '';

  const localState = payload.local?.state || payload.local?.previous || null;
  const remoteState = payload.remote?.state || payload.remote?.previous || null;

  const localEntry = payload.local?.entry || null;
  const remoteEntry = payload.remote?.entry || null;

  const remoteId = String(remoteState?.id || remoteEntry?.id || remoteEntry?.file_entry_id || remoteEntry?.fileEntryId || '').trim();
  const safeRemoteName = String(remoteEntry?.name || path.basename(relativePath || 'remote-file'));

  return {
    kind,
    relativePath,
    local: payload.local?.exists
      ? { exists: true, state: localState, path: String(localEntry?.absolutePath || '') }
      : { exists: false, previous: localState },
    remote: payload.remote?.exists
      ? { exists: true, state: remoteState, id: remoteId, name: safeRemoteName }
      : { exists: false, previous: remoteState },
  };
}

async function openConflictWindow(conflictPayload) {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + crypto.randomBytes(4).toString('hex');
  const payload = toSafeConflictPayload(conflictPayload, activeSyncConfig);
  if (!payload) return null;

  return new Promise(resolve => {
    pendingConflicts.set(id, { payload, resolve, win: null });

    const win = new BrowserWindow({
      width: 720,
      height: 500,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent: mainWindow || undefined,
      modal: Boolean(mainWindow),
      title: 'Conflict',
      icon: getNotificationIcon() || undefined,
      webPreferences: {
        preload: path.join(__dirname, 'conflict-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const entry = pendingConflicts.get(id);
    if (entry) entry.win = win;

    win.on('closed', () => {
      const entry = pendingConflicts.get(id);
      if (entry) {
        entry.resolve('skip');
        pendingConflicts.delete(id);
      }
    });

    (async () => {
    try {
      await win.loadFile(path.join(__dirname, 'conflict.html'), { query: { id } });
} catch {
      // Best-effort
    }
  })();
});
}

function resolveConflictWithQueue(conflictPayload) {
  const kind = String(conflictPayload?.kind || 'both-changed');
  const remembered = conflictDecisionByKind.get(kind);
  if (remembered) return Promise.resolve(remembered);

  conflictQueue = conflictQueue.then(() => openConflictWindow(conflictPayload));
  return conflictQueue;
}

function registerIpc() {
  ipcMain.handle('conflict:get', async (_, id) => {
    const entry = pendingConflicts.get(String(id || ''));
    return entry ? entry.payload : null;
  });

  ipcMain.handle('conflict:choose', async (_, id, decision, options) => {
    const key = String(id || '');
    const entry = pendingConflicts.get(key);
    if (!entry) return { ok: false };
    pendingConflicts.delete(key);

    const normalizedDecision = String(decision || 'skip');
    const applyToAll = Boolean(options && options.applyToAll);

    if (applyToAll && normalizedDecision && normalizedDecision !== 'skip') {
      conflictDecisionByKind.set(String(entry.payload?.kind || 'both-changed'), normalizedDecision);
    }

    entry.resolve(normalizedDecision);
    try {
      if (entry.win && !entry.win.isDestroyed()) entry.win.close();
    } catch {
      // Best-effort.
    }
    return { ok: true };
  });

  ipcMain.handle('conflict:openLocal', async (_, id) => {
    const entry = pendingConflicts.get(String(id || ''));
    const localPath = String(entry?.payload?.local?.path || '').trim();
    if (!localPath) return { ok: false };
    try {
      await shell.openPath(localPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not open the local file.' };
    }
  });

  ipcMain.handle('conflict:openRemote', async (_, id) => {
    const entry = pendingConflicts.get(String(id || ''));
    const remoteId = String(entry?.payload?.remote?.id || entry?.payload?.remote?.state?.id || '').trim();
    const remoteName = String(entry?.payload?.remote?.name || path.basename(String(entry?.payload?.relativePath || 'cloud-file')));

    if (!remoteId) return { ok: false, error: 'Missing remote file id.' };

    const sanitizeFileName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);

    try {
      const cfg = activeSyncConfig || await loadConfig();
      const client = createClient(cfg);
      const buffer = await client.downloadFile({ id: remoteId, name: remoteName });

      const tempRoot = path.join(getCacheRoot(), 'Cloud Preview');
      await fs.mkdir(tempRoot, { recursive: true });

      const ext = path.extname(remoteName);
      const base = path.basename(remoteName, ext);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filePath = path.join(tempRoot, sanitizeFileName(`${base} (cloud ${stamp})${ext}`));

      await fs.writeFile(filePath, buffer);
      await shell.openPath(filePath);
      return { ok: true, filePath };
    } catch (error) {
      return { ok: false, error: error?.message || 'Could not download/open the cloud file.' };
    }
  });

  ipcMain.handle('conflict:openBoth', async (_, id) => {
    const entry = pendingConflicts.get(String(id || ''));
    if (!entry) return { ok: false };

    const localPath = String(entry?.payload?.local?.path || '').trim();
    const remoteId = String(entry?.payload?.remote?.id || entry?.payload?.remote?.state?.id || '').trim();
    const remoteName = String(entry?.payload?.remote?.name || path.basename(String(entry?.payload?.relativePath || 'cloud-file')));

    let ok = false;

    if (localPath) {
      try {
        await shell.openPath(localPath);
        ok = true;
      } catch {
        // Best-effort.
      }
    }

    if (remoteId) {
      const sanitizeFileName = (name) => name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
      try {
        const cfg = activeSyncConfig || await loadConfig();
        const client = createClient(cfg);
        const buffer = await client.downloadFile({ id: remoteId, name: remoteName });

        const tempRoot = path.join(getCacheRoot(), 'Cloud Preview');
        await fs.mkdir(tempRoot, { recursive: true });

        const ext = path.extname(remoteName);
        const base = path.basename(remoteName, ext);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(tempRoot, sanitizeFileName(`${base} (cloud ${stamp})${ext}`));

        await fs.writeFile(filePath, buffer);
        await shell.openPath(filePath);
        ok = true;
      } catch {
        // Best-effort.
      }
    }

    return { ok };
  });
  ipcMain.handle('config:load', async () => {
    const config = await loadConfig();
    return {
      config: serializeConfigForRenderer(config),
      explorerShortcutStatus: await getExplorerShortcutStatus(config),
      activityLog,
      status: currentStatus,
      latestSyncResult,
      syncInProgress,
    };
  });

  ipcMain.handle('config:save', async (_, config) => {
    const saved = await saveConfig(config);
    return {
      config: serializeConfigForRenderer(saved),
      explorerShortcutStatus: await getExplorerShortcutStatus(saved),
    };
  });

  ipcMain.handle('config:getDefaultVirtualFilesFolder', async () => {
    return getDefaultVirtualFilesFolder();
  });

  ipcMain.handle('cache:info', async () => {
    return await getCacheInfo();
  });
ipcMain.handle('vfs:status', async () => getVfsStatus());

  ipcMain.handle('cache:cleanup', async () => {
    const cfg = await loadConfig();
    const before = await getCacheInfo();
    const cleanup = await cleanupCache(cfg);
    const after = await getCacheInfo();

    const summary = {
      ranAt: Date.now(),
      source: 'manual',
      deletedFiles: Number(cleanup?.deletedFiles || 0),
      freedBytes: Number(cleanup?.freedBytes || 0),
      before,
      after,
    };
    lastCacheCleanup = summary;

    if (summary.deletedFiles || summary.freedBytes) {
      const freedMb = Math.round((summary.freedBytes / (1024 * 1024)) * 10) / 10;
      addActivity({ level: 'info', message: `Cache cleaned: freed ${freedMb} MB (${summary.deletedFiles} files).` });
    } else {
      addActivity({ level: 'info', message: 'Cache cleaned: nothing to remove.' });
    }

    return { info: after, lastCleanup: summary };
  });


  ipcMain.handle('auth:login', async (_, config) => {
    const incomingConfig = { ...defaultConfig, ...(config || {}) };

    try {
      const authenticated = await loginWithPassword(incomingConfig);
      const saved = await saveConfig(authenticated);
      return {
        config: serializeConfigForRenderer(saved),
        explorerShortcutStatus: await getExplorerShortcutStatus(authenticated),
        activityLog,
        status: currentStatus,
        latestSyncResult,
        syncInProgress,
      };
    } catch (error) {
      // Persist the user's edits (e.g. rememberPassword toggle) without destroying the sign-in password
      // before we attempt the login next time.
      await saveConfig(incomingConfig);
      throw error;
    }
  });

  ipcMain.handle('auth:logout', async (_, config) => {
    const saved = await saveConfig({
      ...config,
      token: '',
      user: null,
      password: config.rememberPassword ? config.password : '',
    });
    addActivity({ level: 'info', message: 'Signed out of BoltBytes' });
    setStatus('Signed out');
    return {
      config: serializeConfigForRenderer(saved),
      explorerShortcutStatus: await getExplorerShortcutStatus(saved),
      activityLog,
      status: currentStatus,
      latestSyncResult,
      syncInProgress,
    };
  });

    ipcMain.handle('sync:togglePause', async (_, config) => {
    const saved = await saveConfig(config);
    const next = { ...saved, syncPaused: !saved.syncPaused };
    const finalConfig = await saveConfig(next);
    setStatus(finalConfig.syncPaused ? 'Paused' : 'Ready');
    addActivity({ level: 'info', message: finalConfig.syncPaused ? 'Sync paused' : 'Sync resumed' });
    updateTrayMenu();
    sendLiveUpdate();
    return { config: serializeConfigForRenderer(finalConfig), status: currentStatus, activityLog, syncInProgress, latestSyncResult };
  });

ipcMain.handle('sync:run', async (_, config) => {
    const saved = await saveConfig(config);
    const result = await performSync(saved);
    const latestConfig = await loadConfig();
    return {
      config: serializeConfigForRenderer(latestConfig),
      result,
      explorerShortcutStatus: await getExplorerShortcutStatus(latestConfig),
      activityLog,
      status: currentStatus,
      latestSyncResult,
      syncInProgress,
    };
  });

  ipcMain.handle('remoteFolders:list', async (_, config) => {
    const saved = await saveConfig(config);
    const authenticated = await ensureAuthenticated(saved);
    const client = createClient(authenticated);
    const folders = await client.listRemoteFolders({ workspaceId: 0 });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      folders,
    };
  });

  
  ipcMain.handle('remoteFolders:listTreePaths', async (_, config) => {
    const saved = await saveConfig(config);
    const authenticated = await ensureAuthenticated(saved);
    const client = createClient(authenticated);
    const parentId = authenticated.remoteFolderId === '__root__' ? '' : (authenticated.remoteFolderId || '');
    const tree = await client.listRemoteTree({ parentId });
    const folders = Array.isArray(tree.folders) ? tree.folders : [];
    const folderPaths = folders
      .map(folder => normalizeRelativePath(folder.path || folder.displayLabel || folder.name || ''))
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'en'));
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      folderPaths,
    };
  });
ipcMain.handle('trash:list', async (_, config) => {
    const saved = await saveConfig(config);
    const { client } = await getAuthenticatedClient(saved);
    const entries = await client.listDeletedEntries({ workspaceId: 0, perPage: 1000 });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      entries,
      activityLog,
    };
  });

  ipcMain.handle('trash:restore', async (_, config, entryIds) => {
    const saved = await saveConfig(config);
    const { client } = await getAuthenticatedClient(saved);
    await client.restoreEntries(entryIds || []);
    addActivity({ level: 'success', message: `Restored ${Array.isArray(entryIds) ? entryIds.length : 1} item(s) from Trash` });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      entries: await client.listDeletedEntries({ workspaceId: 0, perPage: 1000 }),
      activityLog,
    };
  });

  ipcMain.handle('remoteFolders:listChildren', async (_, config, parentId) => {
    const saved = await saveConfig(config);
    const authenticated = await ensureAuthenticated(saved);
    const client = createClient(authenticated);
    const normalizedParentId = parentId && String(parentId).trim() !== '__root__' ? String(parentId).trim() : '';
    const folders = await client.listRemoteFolderChildren({ parentId: normalizedParentId, workspaceId: 0, perPage: 500 });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      folders,
    };
  });
  ipcMain.handle('remoteFolders:createFolder', async (_, config, parentId, folderName) => {
    const saved = await saveConfig(config);
    const { client } = await getAuthenticatedClient(saved);
    const normalizedParentId = parentId && String(parentId).trim() !== '__root__' ? String(parentId).trim() : '';
    const created = await client.createRemoteFolder({ name: folderName, parentId: normalizedParentId, workspaceId: 0 });
    const folders = await client.listRemoteFolderChildren({ parentId: normalizedParentId, workspaceId: 0, perPage: 500 });
    addActivity({ level: 'success', message: `Created folder "${String(folderName || '').trim() || 'New folder'}"` });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      created,
      folders,
      activityLog,
    };
  });


  ipcMain.handle('trash:deletePermanent', async (_, config, entryIds) => {
    const saved = await saveConfig(config);
    const { client } = await getAuthenticatedClient(saved);
    await client.deleteEntries(entryIds || [], { deleteForever: true });
    addActivity({ level: 'warning', message: `Deleted ${Array.isArray(entryIds) ? entryIds.length : 1} item(s) permanently from Trash` });
    return {
      config: serializeConfigForRenderer(await loadConfig()),
      entries: await client.listDeletedEntries({ workspaceId: 0, perPage: 1000 }),
      activityLog,
    };
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return {
      canceled: result.canceled,
      folderPath: result.canceled ? null : (result.filePaths && result.filePaths[0] ? result.filePaths[0] : null),
    };
  });

  ipcMain.handle('shell:openLocalFolder', async (_, config) => {
    if (!config?.localFolder) {
      throw new Error('No local folder selected yet.');
    }

    const openResult = await shell.openPath(config.localFolder);
    if (openResult) {
      throw new Error(openResult);
    }

    return true;
  });

  ipcMain.handle('explorerShortcut:create', async (_, config) => {
    const saved = await saveConfig(config);
    return createExplorerShortcut(saved);
  });

  ipcMain.handle('explorerShortcut:remove', async (_, config) => {
    const saved = await saveConfig(config);
    return removeExplorerShortcut(saved);
  });

  ipcMain.handle('explorerShortcut:status', async (_, config) => {
    const merged = { ...defaultConfig, ...config };
    return getExplorerShortcutStatus(merged);
  });
}



async function getAuthenticatedClient(config) {
  const authenticated = await ensureAuthenticated({ ...defaultConfig, ...config });
  return { authenticated, client: new BoltBytesClient(authenticated) };
}

async function createWindow() {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.boltbytes.syncdesktop');
  }

  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 390,
    minHeight: 620,
    maxWidth: 540,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: false,
    backgroundColor: '#1f1f1f',
    icon: getAppIconPath(),
    roundedCorners: true,
    titleBarStyle: 'hidden',
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  enableDevToolsShortcuts(mainWindow);

  mainWindow.on('ready-to-show', () => {
    positionWindow();
    mainWindow.show();
  });

  mainWindow.on('blur', () => {
    if (!mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.hide();
    }
  });

  mainWindow.on('close', event => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  await mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
  publishVfsStatus();
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(APP_DISPLAY_NAME);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

app.whenReady().then(async () => {
  await ensureWindowsToastShortcut();
  registerIpc();
  createTray();
  createWindow();
  const initialConfig = await loadConfig();
  if (process.platform === 'win32' && initialConfig?.virtualFilesEnabled && initialConfig?.virtualFilesFolder) {
    await ensureDirectoryExists(initialConfig.virtualFilesFolder);
  }
  await configureAutoSyncInfrastructure(initialConfig);
  await configureVfsInfrastructure(initialConfig);
  await scheduleCacheMaintenance(initialConfig);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showWindow();
    }
  });
});

app.on('before-quit', () => {
  app.isQuiting = true;
  stopAutoSyncInfrastructure();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep tray app alive until explicit quit
  }
})

ipcMain.handle('shell:openPath', async (_, targetPath) => {
  const value = String(targetPath || '').trim();
  if (!value) throw new Error('No path specified.');

  // Best-effort: create folder if it doesn't exist (Open folder buttons expect this).
  try {
    await fs.stat(value);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // If it's a file path, create its parent; otherwise create the folder itself.
      const dirToCreate = path.extname(value) ? path.dirname(value) : value;
      await fs.mkdir(dirToCreate, { recursive: true });
    } else {
      throw err;
    }
  }

  const openResult = await shell.openPath(value);
  if (openResult) throw new Error(openResult);
  return true;
});

;