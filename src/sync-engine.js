const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { BoltBytesClient } = require('./api-client');

const LOCAL_SYNC_STATE_FILE = '.boltbytes-sync-state.json';
const HIDDEN_LOCAL_FILE_NAMES = new Set([
  LOCAL_SYNC_STATE_FILE.toLowerCase(),
  'desktop.ini',
  '.boltbytes-folder.ico',
  '.boltbytes-trash',
]);
const DEFAULT_CONCURRENCY = 3;

function normalizeRelativePath(value) {
  return String(value || '').split(path.sep).join('/').replace(/^\//, '');
}

function normalizeRemoteRelativePath(value) {
  return normalizeRelativePath(String(value || '').replace(/^\/+/, ''));
}

function splitLines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function globToRegExp(globPattern) {
  const glob = String(globPattern || '').trim();
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    const next = glob[i + 1];

    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out, 'i');
}

function createIgnoreMatcher(rulesText) {
  const rules = [];
  for (const rawLine of splitLines(rulesText)) {
    if (rawLine.startsWith('#')) continue;
    const negated = rawLine.startsWith('!');
    const line = negated ? rawLine.slice(1).trim() : rawLine;
    if (!line) continue;

    const dirOnly = line.endsWith('/');
    const rooted = line.startsWith('/');
    const cleaned = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned) continue;

    const hasSlash = cleaned.includes('/');
    const regex = globToRegExp(cleaned);

    rules.push({
      raw: rawLine,
      negated,
      dirOnly,
      rooted,
      hasSlash,
      cleaned,
      regex,
    });
  }

  function matchesDirectoryRule(rel, rule) {
    if (!rule.dirOnly) return false;

    if (rule.rooted || rule.hasSlash) {
      return rel === rule.cleaned || rel.startsWith(`${rule.cleaned}/`);
    }

    const segments = rel.split('/').filter(Boolean);
    return segments.includes(rule.cleaned);
  }

  return (relativePath, isDir = false) => {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) return false;
    const basename = path.posix.basename(rel);

    let ignored = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        // Still allow directory pattern to match descendants.
        if (!matchesDirectoryRule(rel, rule)) continue;
      }

      const candidate = rule.rooted || rule.hasSlash ? rel : basename;
      const matched = rule.regex.test(candidate) || matchesDirectoryRule(rel, rule);
      if (!matched) continue;
      ignored = !rule.negated;
    }
    return ignored;
  };
}

function createExcludedFolderMatcher(excludedFolders) {
  const prefixes = (excludedFolders || [])
    .map(value => normalizeRelativePath(value).replace(/\/+$/, ''))
    .filter(Boolean)
    .map(value => `${value}/`);

  return relativePath => {
    const rel = normalizeRelativePath(relativePath);
    if (!rel) return false;
    return prefixes.some(prefix => rel === prefix.replace(/\/$/, '') || rel.startsWith(prefix));
  };
}


async function hashBuffer(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return hashBuffer(buffer);
}

async function walkDirectory(rootDir, options = {}) {
  const entries = [];
  const ignore = typeof options.ignore === 'function' ? options.ignore : (() => false);
  const isExcluded = typeof options.isExcluded === 'function' ? options.isExcluded : (() => false);

  async function visit(currentDir) {
    const children = await fs.readdir(currentDir, { withFileTypes: true });
    for (const child of children) {
      const absolutePath = path.join(currentDir, child.name);
      const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
      const isDir = child.isDirectory();

      if (HIDDEN_LOCAL_FILE_NAMES.has(String(child.name).toLowerCase())) continue;
      if (ignore(relativePath, isDir) || isExcluded(relativePath, isDir)) {
        continue;
      }

      if (isDir) {
        await visit(absolutePath);
        continue;
      }

      if (!child.isFile()) continue;
      const stats = await fs.stat(absolutePath);
      const sha1 = await hashFile(absolutePath);
      entries.push({
        name: child.name,
        absolutePath,
        relativePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
        ctimeMs: stats.ctimeMs,
        sha1,
      });
    }
  }

  await visit(rootDir);
  return entries;
}


async function ensureParentDirectory(filePath, rootDir, createdFolders = null) {
  const destinationDir = path.dirname(filePath);
  if (!rootDir || !createdFolders) {
    await fs.mkdir(destinationDir, { recursive: true });
    return;
  }

  const relativeDir = normalizeRelativePath(path.relative(rootDir, destinationDir));
  if (!relativeDir) {
    await fs.mkdir(destinationDir, { recursive: true });
    return;
  }

  const segments = relativeDir.split('/').filter(Boolean);
  let current = path.resolve(rootDir);
  let prefix = '';

  for (const segment of segments) {
    current = path.join(current, segment);
    prefix = prefix ? `${prefix}/${segment}` : segment;
    try {
      const stat = await fs.stat(current);
      if (!stat.isDirectory()) throw new Error('Not a directory.');
    } catch {
      await fs.mkdir(current, { recursive: false });
      createdFolders.add(prefix);
    }
  }
}


function detectContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
  };
  return types[extension] || 'application/octet-stream';
}

function detectClientExtension(filePath) {
  return path.extname(filePath).replace(/^\./, '').toLowerCase();
}

function remoteEntryToState(entry) {
  const created = entry?.createdAtMs || Date.parse(entry?.created_at || entry?.createdAt || 0) || 0;
  const updated = entry?.updatedAtMs || Date.parse(entry?.updated_at || entry?.updatedAt || 0) || 0;
  return {
    id: entry?.id || entry?.file_entry_id || entry?.fileEntryId || '',
    size: Number(entry?.fileSize ?? entry?.file_size ?? entry?.size ?? 0) || 0,
    createdAtMs: Number(created) || 0,
    updatedAtMs: Number(updated) || 0,
    sha1: entry?.sha1 || entry?.hash || entry?.file_hash || entry?.fileHash || '',
  };
}

function localEntryToState(entry) {
  return {
    size: Number(entry?.size || 0) || 0,
    mtimeMs: Number(entry?.mtimeMs || 0) || 0,
    birthtimeMs: Number(entry?.birthtimeMs || 0) || 0,
    ctimeMs: Number(entry?.ctimeMs || 0) || 0,
    sha1: entry?.sha1 || '',
  };
}

function metadataChanged(current, previous) {
  if (!current && !previous) return false;
  if (!current || !previous) return true;
  if (current.sha1 && previous.sha1) return current.sha1 !== previous.sha1;
  if (current.size !== previous.size) return true;
  const currentTime = current.updatedAtMs ?? current.mtimeMs ?? 0;
  const previousTime = previous.updatedAtMs ?? previous.mtimeMs ?? 0;
  return Math.abs(currentTime - previousTime) > 1000;
}

function buildConflictCopyPath(localFilePath) {
  const timestamp = new Date().toISOString().replace(/[:T]/g, '-').replace(/\..+/, '');
  const extension = path.extname(localFilePath);
  const basename = path.basename(localFilePath, extension);
  return path.join(path.dirname(localFilePath), `${basename} (conflict ${timestamp})${extension}`);
}

async function runWithConcurrency(items, concurrency, worker) {
  const limit = Math.max(1, Number(concurrency) || 1);
  let index = 0;

  async function next() {
    while (true) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= items.length) return;
      await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => next()));
}

async function runSync(config, options = {}) {
  const emit = options.onEvent || (() => {});
  const persistedEntries = options.persistedState?.entries || {};
  const concurrency = Math.max(1, Number(config.syncConcurrency || DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY);

  const shouldTrashLocalDeletes = config.moveLocalDeletesToTrash !== false;
  const moveToTrash = typeof options.moveToTrash === 'function' ? options.moveToTrash : null;
  const canPromptConflicts = config.conflictStrategy === 'ask' && typeof options.onConflict === 'function';

  const createdAtIso = () => new Date().toISOString();
  const pendingOps = Array.isArray(options.pendingOps) ? options.pendingOps.slice() : [];
  // Let the UI reflect persisted queue count immediately.
  emit({ type: 'queue-state', pendingOps: pendingOps.slice() });

  const isRetriableOperationError = (error) => {
    const status = Number(error?.status || 0);
    if (status === 429 || status === 408) return true;
    if (status >= 500 && status <= 599) return true;
    const msg = String(error?.message || error || '');
    if (/Network|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) return true;
    return false;
  };

  const emitQueueState = () => {
    emit({ type: 'queue-state', pendingOps: pendingOps.slice() });
  };

  const emitQueue = (op) => {
    if (!op) return;
    pendingOps.push(op);
    emit({ type: 'queue', op });
    emitQueueState();
  };

  async function processPendingOps(clientInstance) {
    if (!pendingOps.length) return;
    emitQueueState();
    emit({ type: 'status', phase: 'queue', message: `Processing ${pendingOps.length} queued operation(s)…` });

    const remaining = [];
    for (const op of pendingOps) {
      if (!op || typeof op !== 'object') continue;
      const kind = String(op.kind || '').toLowerCase();
      try {
        if (kind === 'delete-remote') {
          const ids = Array.isArray(op.entryIds) ? op.entryIds : [];
          if (!ids.length) continue;
          await clientInstance.deleteEntries(ids, { deleteForever: Boolean(op.deleteForever) });
          emit({ type: 'activity', level: 'info', action: 'queued-delete', path: op.relativePath, message: `Queued delete applied: ${op.relativePath || ids.join(', ')}` });
          continue;
        }

        if (kind === 'upload-file') {
          const abs = String(op.localPath || '');
          if (!abs) continue;
          const stat = await fs.stat(abs);
          const fingerprint = op.fingerprint || {};
          if (fingerprint.size && Number(fingerprint.size) !== Number(stat.size)) {
            emit({ type: 'activity', level: 'warning', action: 'warning', path: op.relativePath, message: `Queued upload skipped (file changed): ${op.relativePath}` });
            continue;
          }
          const buffer = await fs.readFile(abs);
          await clientInstance.uploadFile({
            fileName: op.fileName,
            contentType: op.contentType,
            clientExtension: op.clientExtension,
            backendId: op.backendId,
            parentId: op.parentId,
            uploadType: op.uploadType,
            relativePath: op.relativePath,
            buffer,
            workspaceId: op.workspaceId ?? 0,
          });
          emit({ type: 'activity', level: 'info', action: 'queued-upload', path: op.relativePath, message: `Queued upload applied: ${op.relativePath}` });
          continue;
        }
      } catch (error) {
        if (isRetriableOperationError(error)) {
          remaining.push(op);
          continue;
        }
        emit({ type: 'activity', level: 'warning', action: 'warning', path: op.relativePath, message: `Queued op dropped: ${String(error?.message || error)}` });
      }
    }

    pendingOps.length = 0;
    pendingOps.push(...remaining);
    emitQueueState();
  }

  async function safeUpload(localFile, uploadPayload) {
    const delays = [0, 900, 1800];
    let lastError = null;

    for (const delayMs of delays) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        return await client.uploadFile(uploadPayload);
      } catch (error) {
        lastError = error;
        if (!isRetriableOperationError(error)) throw error;
      }
    }

    emitQueue({
      kind: 'upload-file',
      createdAt: createdAtIso(),
      relativePath: uploadPayload.relativePath,
      localPath: localFile?.absolutePath || '',
      fileName: uploadPayload.fileName,
      contentType: uploadPayload.contentType,
      clientExtension: uploadPayload.clientExtension,
      backendId: uploadPayload.backendId,
      parentId: uploadPayload.parentId,
      uploadType: uploadPayload.uploadType,
      workspaceId: uploadPayload.workspaceId ?? 0,
      fingerprint: { size: localFile?.size, mtimeMs: localFile?.mtimeMs, sha1: localFile?.sha1 },
    });
    return { queued: true, error: lastError };
  }

  async function safeDeleteRemote(relativePath, remoteId, { deleteForever = false } = {}) {
    const delays = [0, 900, 1800];
    let lastError = null;

    for (const delayMs of delays) {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      try {
        await client.deleteEntries([remoteId], { deleteForever });
        return { ok: true };
      } catch (error) {
        lastError = error;
        if (!isRetriableOperationError(error)) throw error;
      }
    }

    emitQueue({ kind: 'delete-remote', createdAt: createdAtIso(), relativePath, entryIds: [remoteId], deleteForever });
    return { queued: true, error: lastError };
  }

  async function deleteLocalFileSafely(filePath) {
    if (!filePath) return;

    const rootDir = config.localFolder ? path.resolve(String(config.localFolder)) : null;
    const resolvedPath = path.resolve(String(filePath));
    const relativeFromRoot = rootDir ? path.relative(rootDir, resolvedPath) : null;
    const isWithinRoot = Boolean(
      rootDir
      && typeof relativeFromRoot === 'string'
      && !relativeFromRoot.startsWith('..')
      && !path.isAbsolute(relativeFromRoot)
    );

    const relativeForMessage = isWithinRoot
      ? normalizeRelativePath(relativeFromRoot)
      : path.basename(resolvedPath);

    async function copyDirRecursive(sourceDir, destinationDir) {
      await fs.mkdir(destinationDir, { recursive: true });
      const entries = await fs.readdir(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        const from = path.join(sourceDir, entry.name);
        const to = path.join(destinationDir, entry.name);
        if (entry.isDirectory()) {
          await copyDirRecursive(from, to);
        } else if (entry.isSymbolicLink()) {
          const linkTarget = await fs.readlink(from);
          await fs.symlink(linkTarget, to);
        } else {
          await fs.copyFile(from, to);
        }
      }
    }

    async function moveToAppTrash() {
      if (!isWithinRoot) return null;

      const relativePath = normalizeRelativePath(relativeFromRoot);
      if (!relativePath || relativePath.startsWith('..')) return null;

      const trashRoot = path.join(rootDir, '.boltbytes-trash');
      await fs.mkdir(trashRoot, { recursive: true });

      const safeName = relativePath.split('/').join('__');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(3).toString('hex');
      const destination = path.join(trashRoot, `${stamp}_${rand}__${safeName}`);

      try {
        await fs.rename(resolvedPath, destination);
        return destination;
      } catch (err) {
        if (err && err.code === 'EXDEV') {
          const stat = await fs.lstat(resolvedPath);
          if (stat.isDirectory()) {
            if (typeof fs.cp === 'function') {
              await fs.cp(resolvedPath, destination, { recursive: true, errorOnExist: false });
            } else {
              await copyDirRecursive(resolvedPath, destination);
            }
          } else {
            await fs.copyFile(resolvedPath, destination);
          }
          await fs.rm(resolvedPath, { recursive: true, force: true });
          return destination;
        }
        throw err;
      }
    }

    try {
      await fs.lstat(resolvedPath);
    } catch {
      return;
    }

    if (shouldTrashLocalDeletes) {
      if (moveToTrash) {
        try {
          await moveToTrash(resolvedPath);
          return;
        } catch {
          // Best-effort, fallback below.
        }
      }

      try {
        const destination = await moveToAppTrash();
        if (destination) {
          const message = `Moved ${relativeForMessage} to BoltBytes Trash.`;
          warnings.push(message);
          emit({ type: 'activity', level: 'warning', action: 'trashed-local', path: relativeForMessage, message });
          return;
        }
      } catch {
        // Best-effort, do not permanently delete when trashing is enabled.
      }

      const message = `Unable to move ${relativeForMessage} to Trash. File was left in place.`;
      warnings.push(message);
      emit({ type: 'activity', level: 'warning', action: 'trash-failed', path: relativeForMessage, message });
      return;
    }

    await fs.rm(resolvedPath, { recursive: true, force: true });
  }

  async function promptConflict(payload) {
    if (!canPromptConflicts) return null;
    try {
      return await options.onConflict(payload);
    } catch {
      return null;
    }
  }

  await fs.access(config.localFolder);
  emit({ type: 'status', phase: 'scan', message: 'Scanning local folder…' });

  const ignoreMatcher = createIgnoreMatcher(config.ignoreRulesText || '');
  const isExcludedFolder = createExcludedFolderMatcher(config.selectiveSyncExcludedFolders || []);
  const recentLocalDeletes = new Set((options.recentLocalDeletes || []).map(normalizeRelativePath));

  const client = new BoltBytesClient({
    baseUrl: config.baseUrl,
    token: config.token,
    debug: typeof options.apiDebug === 'function' ? options.apiDebug : null,
  });
  await processPendingOps(client);
  const localFiles = await walkDirectory(config.localFolder, { ignore: ignoreMatcher, isExcluded: (rel) => isExcludedFolder(rel) });
  emit({ type: 'status', phase: 'remote', message: 'Loading remote file tree…', localCount: localFiles.length });

  const selectedParentId = config.remoteFolderId === '__root__'
    ? ''
    : (config.remoteFolderId || '');

  const remoteTree = await client.listRemoteTree({ parentId: selectedParentId });

  const remoteFolders = Array.isArray(remoteTree.folders) ? remoteTree.folders : [];
  const remoteFolderPaths = remoteFolders
    .map(folder => normalizeRemoteRelativePath(folder.path || folder.displayLabel || folder.name || ''))
    .filter(Boolean);

  const remoteFiles = remoteTree.files
    .map(entry => ({ ...entry, relativePath: normalizeRemoteRelativePath(entry.relativePath || entry.relative_path || entry.name) }))
    .filter(entry => !ignoreMatcher(entry.relativePath, false) && !isExcludedFolder(entry.relativePath));

  const uploadEnabled = config.enableUploadSync !== false && !config.suppressUploadsThisRun;
  if (!uploadEnabled) {
    emit({ type: 'activity', level: 'warning', action: 'warning', message: 'Uploads are disabled for this run.' });
  }

  const remoteMap = new Map(remoteFiles.map(entry => [entry.relativePath, entry]));
  const localMap = new Map(localFiles.map(file => [file.relativePath, file]));
  const allPaths = [...new Set([...localMap.keys(), ...remoteMap.keys()])].sort((a, b) => a.localeCompare(b, 'da'));

  const uploaded = [];
  const downloaded = [];
  const skipped = [];
  const warnings = [];
  const conflicts = [];
  const syncStateEntries = { ...persistedEntries };
  const foldersCreated = new Set();
  const totalOperations = allPaths.length;
  let completedOperations = 0;
  const live = { uploading: 0, downloading: 0, conflicts: 0 };

  const emitProgress = ({ action, path: relativePath, message }) => {
    completedOperations += 1;
    emit({
      type: 'progress',
      completed: completedOperations,
      total: totalOperations,
      action,
      path: relativePath,
      message,
      live: { ...live },
    });
  };

  if (config.enableDownloadSync && remoteFolderPaths.length) {
    for (const folderPath of remoteFolderPaths) {
      const destination = path.join(config.localFolder, folderPath);
      let created = false;
      try {
        const stat = await fs.stat(destination);
        if (!stat.isDirectory()) {
          throw new Error('Path exists but is not a directory.');
        }
      } catch {
        await fs.mkdir(destination, { recursive: true });
        foldersCreated.push(folderPath);
        created = true;
        emit({ type: 'activity', level: 'info', action: 'folder', path: folderPath, message: `Created folder ${folderPath}` });
      }
      emitProgress({
        action: created ? 'folder-created' : 'folder-exists',
        path: folderPath,
        message: created ? `Folder created: ${folderPath}` : `Folder exists: ${folderPath}`,
      });
    }
  }


  const processPath = async relativePath => {
    const localFile = localMap.get(relativePath) || null;
    const remoteEntry = remoteMap.get(relativePath) || null;
    const stateEntry = syncStateEntries[relativePath] || {};

    const localState = localFile ? localEntryToState(localFile) : null;
    const remoteState = remoteEntry ? remoteEntryToState(remoteEntry) : null;
    let localChanged = metadataChanged(localState, stateEntry.local || null);
    let remoteChanged = metadataChanged(remoteState, stateEntry.remote || null);

    if (localFile && remoteEntry && !localChanged && remoteChanged) {
      const remoteHasNoStableHash = !remoteState?.sha1;
      const previousLocalSha1 = stateEntry?.local?.sha1 || '';
      const previousRemoteSize = Number(stateEntry?.remote?.size || 0) || 0;
      const localMatchesPrevious = Boolean(previousLocalSha1 && localState?.sha1 && previousLocalSha1 === localState.sha1);
      const remoteLooksEquivalent = Boolean(remoteState && localState && remoteState.size === localState.size && (!previousRemoteSize || previousRemoteSize === remoteState.size));
      if (remoteHasNoStableHash && localMatchesPrevious && remoteLooksEquivalent) {
        remoteChanged = false;
      }
    }

    
    const hadLocalBefore = Boolean(stateEntry?.local);
    const hadRemoteBefore = Boolean(stateEntry?.remote && (stateEntry.remote.id || stateEntry.remote.size || stateEntry.remote.updatedAtMs || stateEntry.remote.createdAtMs));
    const knownSyncedBefore = hadLocalBefore && hadRemoteBefore;
    const destinationPath = path.join(config.localFolder, relativePath);

    if (knownSyncedBefore && !localFile && remoteEntry) {
      if (remoteChanged) {
        const decision = await promptConflict({
          kind: 'local-deleted-remote-changed',
          relativePath,
          local: { exists: false, previous: stateEntry.local || null },
          remote: { exists: true, entry: remoteEntry, state: remoteState },
        });

        const fallbackAction = config.conflictStrategy === 'prefer-remote' ? 'prefer-remote' : 'delete-remote';
        const action = decision || fallbackAction;

        if (action === 'skip') {
          const message = `Skipped conflict resolution for ${relativePath}`;
          warnings.push(message);
          syncStateEntries[relativePath] = {
            ...(syncStateEntries[relativePath] || {}),
            state: 'conflict',
            updatedAt: new Date().toISOString(),
            local: null,
            remote: remoteState,
            message,
          };
          emit({ type: 'activity', level: 'warning', action: 'conflict', path: relativePath, message });
          emitProgress({ action: 'conflict', path: relativePath, message });
          return;
        }
        if (action === 'prefer-remote') {
          if (!config.enableDownloadSync) {
            const message = `Conflict on ${relativePath}: cloud version is preferred, but download sync is disabled.`;
            warnings.push(message);
            emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
            emitProgress({ action: 'warning', path: relativePath, message });
            return;
          }
          live.downloading += 1;
          emit({ type: 'activity', level: 'info', action: 'downloading', path: relativePath, message: `Restoring ${relativePath} from the cloud` });
          const buffer = await client.downloadFile(remoteEntry);
          await ensureParentDirectory(destinationPath, config.localFolder, foldersCreated);
          await fs.writeFile(destinationPath, buffer);
          const sha1 = await hashBuffer(buffer);
          const stats = await fs.stat(destinationPath);
          live.downloading -= 1;
          downloaded.push(relativePath);
          syncStateEntries[relativePath] = { state: 'synced', updatedAt: new Date().toISOString(), local: { size: stats.size, mtimeMs: stats.mtimeMs, birthtimeMs: stats.birthtimeMs, ctimeMs: stats.ctimeMs, sha1 }, remote: { ...remoteState, sha1: remoteState?.sha1 || sha1 } };
          emitProgress({ action: 'downloaded', path: relativePath, message: `Restored from cloud: ${relativePath}` });
          return;
        }

        if (!uploadEnabled) {
          syncStateEntries[relativePath] = {
            ...stateEntry,
            state: 'synced',
            updatedAt: new Date().toISOString(),
            local: null,
            remote: remoteState,
          };
          const message = `Conflict on ${relativePath}: local deletion detected, but uploads are disabled (cannot delete the cloud version).`;
          warnings.push(message);
          emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
          emitProgress({ action: 'warning', path: relativePath, message });
          return;
        }

        const remoteId = String(remoteState?.id || remoteEntry?.id || stateEntry?.remote?.id || '').trim();
        live.uploading += 1;
        emit({ type: 'activity', level: 'warning', action: 'deleting-remote', path: relativePath, message: `Conflict detected, deleting the cloud version of ${relativePath}` });
        const deleteResult = await safeDeleteRemote(relativePath, remoteId, { deleteForever: false });
        if (deleteResult?.queued) {
          live.uploading -= 1;
          syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString(), pendingRemoteDeleteUntilMs: Date.now() + 60000 };
          emitProgress({ action: 'queued-delete', path: relativePath, message: `Queued delete: ${relativePath}` });
          return;
        }
        live.uploading -= 1;

        live.uploading -= 1;
        syncStateEntries[relativePath] = { state: 'deleted', updatedAt: new Date().toISOString(), local: null, remote: null };
        emitProgress({ action: 'deleted-remote', path: relativePath, message: `Deleted from cloud: ${relativePath}` });
        return;
      }

      if (!uploadEnabled) {
        syncStateEntries[relativePath] = {
          ...stateEntry,
          state: 'synced',
          updatedAt: new Date().toISOString(),
          local: null,
          remote: remoteState,
        };
        skipped.push(`Upload disabled: ${relativePath}`);
        emitProgress({ action: 'skip-upload', path: relativePath, message: `Upload disabled: ${relativePath}` });
        return;
      }

      const remoteId = String(remoteState?.id || remoteEntry?.id || stateEntry?.remote?.id || '').trim();
      live.uploading += 1;
      emit({ type: 'activity', level: 'info', action: 'deleting-remote', path: relativePath, message: `Deleting the cloud copy of ${relativePath}` });
      const deleteResult = await safeDeleteRemote(relativePath, remoteId, { deleteForever: false });
      if (deleteResult?.queued) {
        live.uploading -= 1;
        syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString(), pendingRemoteDeleteUntilMs: Date.now() + 60000 };
        emitProgress({ action: 'queued-delete', path: relativePath, message: `Queued delete: ${relativePath}` });
        return;
      }
      live.uploading -= 1;
      syncStateEntries[relativePath] = { state: 'deleted', updatedAt: new Date().toISOString(), local: null, remote: null };
      emitProgress({ action: 'deleted-remote', path: relativePath, message: `Deleted from cloud: ${relativePath}` });
      return;
    }

    if (knownSyncedBefore && localFile && !remoteEntry) {
      if (localChanged) {
        const decision = await promptConflict({
          kind: 'remote-deleted-local-changed',
          relativePath,
          local: { exists: true, entry: localFile, state: localState },
          remote: { exists: false, previous: stateEntry.remote || null },
        });

        const fallbackAction = config.conflictStrategy === 'prefer-remote' ? 'delete-local' : 'prefer-local';
        const action = decision || fallbackAction;

        if (action === 'skip') {
          const message = `Skipped conflict resolution for ${relativePath}`;
          warnings.push(message);
          syncStateEntries[relativePath] = {
            ...(syncStateEntries[relativePath] || {}),
            state: 'conflict',
            updatedAt: new Date().toISOString(),
            local: null,
            remote: remoteState,
            message,
          };
          emit({ type: 'activity', level: 'warning', action: 'conflict', path: relativePath, message });
          emitProgress({ action: 'conflict', path: relativePath, message });
          return;
        }
        if (action === 'delete-local') {
          if (!config.enableDownloadSync) {
            const message = `Conflict on ${relativePath}: cloud deletion detected, but download sync is disabled (cannot remove the local copy).`;
            warnings.push(message);
            emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
            emitProgress({ action: 'warning', path: relativePath, message });
            return;
          }
          emit({ type: 'activity', level: 'info', action: 'deleting-local', path: relativePath, message: `Removing local copy of ${relativePath}` });
          await deleteLocalFileSafely(localFile.absolutePath || destinationPath);
          syncStateEntries[relativePath] = { state: 'deleted', updatedAt: new Date().toISOString(), local: null, remote: null };
          emitProgress({ action: 'deleted-local', path: relativePath, message: `Removed locally: ${relativePath}` });
          return;
        }

        if (!uploadEnabled) {
          const message = `Conflict on ${relativePath}: local version is preferred, but uploads are disabled.`;
          warnings.push(message);
          emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
          emitProgress({ action: 'warning', path: relativePath, message });
          return;
        }

        live.uploading += 1;
        emit({ type: 'activity', level: 'info', action: 'uploading', path: relativePath, message: `Conflict detected, restoring ${relativePath} to the cloud` });
        const buffer = await fs.readFile(localFile.absolutePath);
        const uploadPayload = {
          fileName: localFile.name,
          contentType: detectContentType(localFile.absolutePath),
          clientExtension: detectClientExtension(localFile.absolutePath),
          backendId: config.backendId,
          parentId: selectedParentId,
          uploadType: config.uploadType || 'bedrive',
          relativePath,
          buffer,
          workspaceId: 0,
        };
        const uploadResult = await safeUpload(localFile, uploadPayload);
        live.uploading -= 1;
        if (uploadResult?.queued) {
          syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString() };
          emitProgress({ action: 'queued-upload', path: relativePath, message: `Queued upload: ${relativePath}` });
          return;
        }
        uploaded.push(relativePath);
        if (uploadResult?.queued) {
        live.uploading -= 1;
        syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString() };
        emitProgress({ action: 'queued-upload', path: relativePath, message: `Queued upload: ${relativePath}` });
        return;
      }

      const uploadedEntry = uploadResult?.entry || null;
        const uploadedRemoteState = uploadedEntry ? remoteEntryToState(uploadedEntry) : null;
        syncStateEntries[relativePath] = {
          state: 'synced',
          uploadedViaClient: true,
          updatedAt: new Date().toISOString(),
          local: localState,
          remote: {
            id: String(uploadedEntry?.id ?? uploadedEntry?.file_entry_id ?? uploadedEntry?.fileEntryId ?? ''),
            size: Number(uploadedRemoteState?.size || localState.size || 0),
            createdAtMs: Number(uploadedRemoteState?.createdAtMs || Date.now()),
            updatedAtMs: Number(uploadedRemoteState?.updatedAtMs || Date.now()),
            sha1: uploadedRemoteState?.sha1 || localState.sha1 || '',
          },
        };
        emitProgress({ action: 'uploaded', path: relativePath, message: `Conflict resolved with the local version: ${relativePath}` });
        return;
      }

      if (!config.enableDownloadSync) {
        skipped.push(`Cloud deleted but download is disabled: ${relativePath}`);
        emitProgress({ action: 'skip-download-disabled', path: relativePath, message: `Cloud deletion skipped: ${relativePath}` });
        return;
      }

      emit({ type: 'activity', level: 'info', action: 'deleting-local', path: relativePath, message: `Removing local copy of ${relativePath}` });
      await deleteLocalFileSafely(localFile.absolutePath || destinationPath);
      syncStateEntries[relativePath] = { state: 'deleted', updatedAt: new Date().toISOString(), local: null, remote: null };
      emitProgress({ action: 'deleted-local', path: relativePath, message: `Removed locally: ${relativePath}` });
      return;
    }

if (localFile && !remoteEntry) {
      if (!uploadEnabled) {
        syncStateEntries[relativePath] = {
          ...stateEntry,
          state: 'synced',
          updatedAt: new Date().toISOString(),
          local: localState,
          remote: null,
        };
        skipped.push(`Upload disabled: ${relativePath}`);
        emitProgress({ action: 'skip-upload', path: relativePath, message: `Upload disabled: ${relativePath}` });
        return;
      }

      const hasStableRemoteId = Boolean(stateEntry?.remote?.id);
      const uploadedViaClient = stateEntry?.uploadedViaClient === true;
      const hasTrustedLocalFingerprint = Boolean(
        stateEntry?.local
        && Number(stateEntry.local.size || 0) === Number(localState?.size || 0)
        && Math.abs(Number(stateEntry.local.mtimeMs || 0) - Number(localState?.mtimeMs || 0)) <= 1000
        && (!stateEntry.local.sha1 || !localState?.sha1 || stateEntry.local.sha1 === localState.sha1)
      );
      const canSkipUsingSavedState = !localChanged && hasTrustedLocalFingerprint && (hasStableRemoteId || uploadedViaClient);
      if (canSkipUsingSavedState) {
        syncStateEntries[relativePath] = {
          ...stateEntry,
          state: 'synced',
          uploadedViaClient,
          updatedAt: new Date().toISOString(),
          local: localState,
          remote: stateEntry.remote || {
            id: String(stateEntry?.remote?.id || ''),
            size: Number(stateEntry?.remote?.size || localState?.size || 0),
            updatedAtMs: Number(stateEntry?.remote?.updatedAtMs || Date.now()),
            sha1: stateEntry?.remote?.sha1 || localState?.sha1 || '',
          },
        };
        skipped.push(`Skipped unchanged file already tracked remotely: ${relativePath}`);
        emitProgress({ action: 'skip-unchanged', path: relativePath, message: `Already synced: ${relativePath}` });
        return;
      }

      live.uploading += 1;
      emit({ type: 'activity', level: 'info', action: 'uploading', path: relativePath, message: `Uploading ${relativePath}` });
      const buffer = await fs.readFile(localFile.absolutePath);
      const uploadPayload = {
        fileName: localFile.name,
        contentType: detectContentType(localFile.absolutePath),
        clientExtension: detectClientExtension(localFile.absolutePath),
        backendId: config.backendId,
        parentId: selectedParentId,
        uploadType: config.uploadType || 'bedrive',
        relativePath,
        buffer,
        workspaceId: 0,
      };
      const uploadResult = await safeUpload(localFile, uploadPayload);
      const uploadedEntry = uploadResult?.entry || null;
      const uploadedRemoteState = uploadedEntry ? remoteEntryToState(uploadedEntry) : null;
      live.uploading -= 1;
      uploaded.push(relativePath);
      syncStateEntries[relativePath] = {
        ...stateEntry,
        state: 'synced',
        uploadedViaClient: true,
        updatedAt: new Date().toISOString(),
        local: localState,
        remote: {
          id: String(uploadedEntry?.id ?? uploadedEntry?.file_entry_id ?? uploadedEntry?.fileEntryId ?? stateEntry?.remote?.id ?? ''),
          size: Number(uploadedRemoteState?.size || stateEntry?.remote?.size || localState.size || 0),
          updatedAtMs: Number(uploadedRemoteState?.updatedAtMs || stateEntry?.remote?.updatedAtMs || Date.now()),
          sha1: uploadedRemoteState?.sha1 || stateEntry?.remote?.sha1 || localState.sha1 || '',
        },
      };
      emitProgress({ action: 'uploaded', path: relativePath, message: `Upload complete: ${relativePath}` });
      return;
    }

    if (!localFile && remoteEntry) {
      const tombstoneUntil = Number(stateEntry?.pendingRemoteDeleteUntilMs || 0) || 0;
      const isRecentDelete = () => {
        if (recentLocalDeletes.has(relativePath)) return true;
        for (const candidate of recentLocalDeletes) {
          if (candidate && relativePath.startsWith(`${candidate}/`)) return true;
        }
        return false;
      };

      if (uploadEnabled && (tombstoneUntil > Date.now() || isRecentDelete())) {
        const remoteId = String(remoteState?.id || remoteEntry?.id || '').trim();
        if (remoteId) {
          live.uploading += 1;
          emit({ type: 'activity', level: 'info', action: 'deleting-remote', path: relativePath, message: `Deleting the cloud copy of ${relativePath}` });
          const deleteResult = await safeDeleteRemote(relativePath, remoteId, { deleteForever: false });
          live.uploading -= 1;
          if (deleteResult?.queued) {
            syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString(), pendingRemoteDeleteUntilMs: Date.now() + 60000 };
            emitProgress({ action: 'queued-delete', path: relativePath, message: `Queued delete: ${relativePath}` });
            return;
          }
          syncStateEntries[relativePath] = { state: 'deleted', updatedAt: new Date().toISOString(), local: null, remote: null };
          emitProgress({ action: 'deleted-remote', path: relativePath, message: `Deleted from cloud: ${relativePath}` });
          return;
        }
      }

      if (!config.enableDownloadSync) {
        skipped.push(`Skipped remote-only file: ${relativePath}`);
        emitProgress({ action: 'skip-download-disabled', path: relativePath, message: `Download disabled: ${relativePath}` });
        return;
      }

      live.downloading += 1;
      emit({ type: 'activity', level: 'info', action: 'downloading', path: relativePath, message: `Downloading ${relativePath}` });
      const buffer = await client.downloadFile(remoteEntry);
      const destination = path.join(config.localFolder, relativePath);
      await ensureParentDirectory(destination, config.localFolder, foldersCreated);
      await fs.writeFile(destination, buffer);
      const sha1 = await hashBuffer(buffer);
      const stats = await fs.stat(destination);
      live.downloading -= 1;
      downloaded.push(relativePath);
      syncStateEntries[relativePath] = {
        state: 'synced',
        updatedAt: new Date().toISOString(),
        local: { size: stats.size, mtimeMs: stats.mtimeMs, sha1 },
        remote: { ...remoteState, sha1: remoteState?.sha1 || sha1 },
      };
      emitProgress({ action: 'downloaded', path: relativePath, message: `Download complete: ${relativePath}` });
      return;
    }

    if (!localFile && !remoteEntry) {
      skipped.push(`No file found: ${relativePath}`);
      emitProgress({ action: 'skip-missing', path: relativePath, message: `Skipping: ${relativePath}` });
      return;
    }

    if (localChanged && remoteChanged) {
      let strategy = config.conflictStrategy || 'keep-both';
      const destination = path.join(config.localFolder, relativePath);

      if (strategy === 'ask') {
        const decision = await promptConflict({
          kind: 'both-changed',
          relativePath,
          local: { exists: true, entry: localFile, state: localState },
          remote: { exists: true, entry: remoteEntry, state: remoteState },
        });
        if (decision === 'skip') {
          const message = `Skipped conflict resolution for ${relativePath}`;
          warnings.push(message);
          syncStateEntries[relativePath] = {
            ...(syncStateEntries[relativePath] || {}),
            state: 'conflict',
            updatedAt: new Date().toISOString(),
            local: localState,
            remote: remoteState,
            message,
          };
          emit({ type: 'activity', level: 'warning', action: 'conflict', path: relativePath, message });
          emitProgress({ action: 'conflict', path: relativePath, message });
          return;
        }
        if (decision) strategy = decision;
        else strategy = 'keep-both';
      }

      if (!['keep-both', 'prefer-local', 'prefer-remote'].includes(strategy)) {
        strategy = 'keep-both';
      }

      if (strategy === 'prefer-local') {
        live.uploading += 1;
        emit({ type: 'activity', level: 'info', action: 'uploading', path: relativePath, message: `Conflict detected, keeping local version for ${relativePath}` });
        const buffer = await fs.readFile(localFile.absolutePath);
        await client.uploadFile({
          fileName: localFile.name,
          contentType: detectContentType(localFile.absolutePath),
          clientExtension: detectClientExtension(localFile.absolutePath),
          backendId: config.backendId || remoteEntry?.backendId || stateEntry.remote?.backendId || '',
          parentId: selectedParentId,
          uploadType: config.uploadType || 'bedrive',
          relativePath,
          buffer,
        });
        live.uploading -= 1;
        uploaded.push(relativePath);
        syncStateEntries[relativePath] = { state: 'synced', updatedAt: new Date().toISOString(), local: localState, remote: { size: localState.size, updatedAtMs: 0, sha1: localState.sha1 } };
        emitProgress({ action: 'uploaded', path: relativePath, message: `Conflict resolved with the local version: ${relativePath}` });
        return;
      }

      if (strategy === 'prefer-remote') {
        if (!config.enableDownloadSync) {
          const message = `Conflict on ${relativePath}: cloud version is preferred, but download sync is disabled.`;
          warnings.push(message);
          emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
          emitProgress({ action: 'warning', path: relativePath, message });
          return;
        }
        live.downloading += 1;
        emit({ type: 'activity', level: 'info', action: 'downloading', path: relativePath, message: `Conflict detected, keeping the cloud version for ${relativePath}` });
        const buffer = await client.downloadFile(remoteEntry);
        await ensureParentDirectory(destination, config.localFolder, foldersCreated);
        await fs.writeFile(destination, buffer);
        const sha1 = await hashBuffer(buffer);
        const stats = await fs.stat(destination);
        live.downloading -= 1;
        downloaded.push(relativePath);
        syncStateEntries[relativePath] = { state: 'synced', updatedAt: new Date().toISOString(), local: { size: stats.size, mtimeMs: stats.mtimeMs, sha1 }, remote: { ...remoteState, sha1: remoteState?.sha1 || sha1 } };
        emitProgress({ action: 'downloaded', path: relativePath, message: `Conflict resolved with the cloud version: ${relativePath}` });
        return;
      }

      live.conflicts += 1;
      const conflictCopy = buildConflictCopyPath(destination);
      await ensureParentDirectory(conflictCopy);
      await fs.copyFile(destination, conflictCopy);

      if (config.enableDownloadSync) {
        const buffer = await client.downloadFile(remoteEntry);
        await fs.writeFile(destination, buffer);
        const sha1 = await hashBuffer(buffer);
        const stats = await fs.stat(destination);
        conflicts.push(`${relativePath} → local copy saved as ${path.basename(conflictCopy)}`);
        syncStateEntries[relativePath] = {
          state: 'conflict',
          updatedAt: new Date().toISOString(),
          local: { size: stats.size, mtimeMs: stats.mtimeMs, sha1 },
          remote: { ...remoteState, sha1: remoteState?.sha1 || sha1 },
          conflictCopy: path.basename(conflictCopy),
        };
        live.conflicts -= 1;
        emit({ type: 'activity', level: 'warning', action: 'conflict', path: relativePath, message: `Conflict resolved by saving a local copy: ${relativePath}` });
        emitProgress({ action: 'conflict', path: relativePath, message: `Conflict handled: ${relativePath}` });
      } else {
        const message = `Conflict on ${relativePath}: both local and remote changed, but download sync is disabled.`;
        warnings.push(message);
        syncStateEntries[relativePath] = {
          ...syncStateEntries[relativePath],
          state: 'conflict',
          updatedAt: new Date().toISOString(),
          local: localState,
          remote: remoteState,
          conflictCopy: path.basename(conflictCopy),
        };
        live.conflicts -= 1;
        emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
        emitProgress({ action: 'warning', path: relativePath, message });
      }
      return;
    }

    if (localChanged && !remoteChanged) {
      live.uploading += 1;
      emit({ type: 'activity', level: 'info', action: 'uploading', path: relativePath, message: `Uploading changes in ${relativePath}` });
      const buffer = await fs.readFile(localFile.absolutePath);
      const uploadPayload = {
        fileName: localFile.name,
        contentType: detectContentType(localFile.absolutePath),
        clientExtension: detectClientExtension(localFile.absolutePath),
        backendId: config.backendId || remoteEntry?.backendId || stateEntry.remote?.backendId || '',
        parentId: selectedParentId,
        uploadType: config.uploadType || 'bedrive',
        relativePath,
        buffer,
        workspaceId: 0,
      };
      const uploadResult = await safeUpload(localFile, uploadPayload);
      if (uploadResult?.queued) {
        live.uploading -= 1;
        syncStateEntries[relativePath] = { ...(syncStateEntries[relativePath] || {}), state: 'queued', updatedAt: new Date().toISOString() };
        emitProgress({ action: 'queued-upload', path: relativePath, message: `Queued upload: ${relativePath}` });
        return;
      }
      live.uploading -= 1;
      uploaded.push(relativePath);
      syncStateEntries[relativePath] = {
        ...(syncStateEntries[relativePath] || {}),
        state: 'synced',
        uploadedViaClient: true,
        updatedAt: new Date().toISOString(),
        local: localState,
        remote: {
          id: String(syncStateEntries[relativePath]?.remote?.id || stateEntry?.remote?.id || ''),
          size: Number(localState.size || 0),
          updatedAtMs: Date.now(),
          sha1: localState.sha1,
        },
      };
      emitProgress({ action: 'uploaded', path: relativePath, message: `Upload complete: ${relativePath}` });
      return;
    }

    if (!localChanged && remoteChanged) {
      if (!config.enableDownloadSync) {
        skipped.push(`Remote changed but download is disabled: ${relativePath}`);
        emitProgress({ action: 'skip-download-disabled', path: relativePath, message: `Remote change skipped: ${relativePath}` });
        return;
      }

      live.downloading += 1;
      emit({ type: 'activity', level: 'info', action: 'downloading', path: relativePath, message: `Downloading the new remote version of ${relativePath}` });
      const buffer = await client.downloadFile(remoteEntry);
      const destination = path.join(config.localFolder, relativePath);
      await ensureParentDirectory(destination, config.localFolder, foldersCreated);
      await fs.writeFile(destination, buffer);
      const sha1 = await hashBuffer(buffer);
      const stats = await fs.stat(destination);
      live.downloading -= 1;
      downloaded.push(relativePath);
      syncStateEntries[relativePath] = {
        state: 'synced',
        updatedAt: new Date().toISOString(),
        local: { size: stats.size, mtimeMs: stats.mtimeMs, sha1 },
        remote: { ...remoteState, sha1: remoteState?.sha1 || sha1 },
      };
      emitProgress({ action: 'downloaded', path: relativePath, message: `Download complete: ${relativePath}` });
      return;
    }

    skipped.push(`No changes: ${relativePath}`);
    syncStateEntries[relativePath] = {
      ...(syncStateEntries[relativePath] || {}),
      state: 'synced',
      updatedAt: new Date().toISOString(),
      local: localState,
      remote: remoteState || syncStateEntries[relativePath]?.remote || stateEntry?.remote || null,
    };
    emitProgress({ action: 'skip-unchanged', path: relativePath, message: `No changes: ${relativePath}` });
  };

  emit({
    type: 'status',
    phase: 'plan',
    message: `Planned ${allPaths.length} checks with ${concurrency} concurrent jobs.`,
    localCount: localFiles.length,
    remoteCount: remoteFiles.length,
  });

  await runWithConcurrency(allPaths, concurrency, async relativePath => {
    try {
      await processPath(relativePath);
    } catch (error) {
      const message = `${relativePath}: ${error.message}`;
      warnings.push(message);
      syncStateEntries[relativePath] = {
        ...(syncStateEntries[relativePath] || {}),
        state: 'error',
        updatedAt: new Date().toISOString(),
        message,
      };
      emit({ type: 'activity', level: 'warning', action: 'warning', path: relativePath, message });
      emitProgress({ action: 'warning', path: relativePath, message: `Warning for ${relativePath}` });
    }
  });

  const reconciledLocalFiles = await walkDirectory(config.localFolder, {
    ignore: ignoreMatcher,
    isExcluded: (rel) => isExcludedFolder(rel),
  });
  const reconciledRemoteTree = await client.listRemoteTree({ parentId: selectedParentId });
  const reconciledRemoteMap = new Map(reconciledRemoteTree.files.map(entry => [normalizeRemoteRelativePath(entry.relativePath || entry.relative_path || entry.name), entry]));
  for (const localFile of reconciledLocalFiles) {
    const relativePath = localFile.relativePath;
    const remoteEntry = reconciledRemoteMap.get(relativePath) || null;
    const previousEntry = syncStateEntries[relativePath] || {};
    syncStateEntries[relativePath] = {
      ...previousEntry,
      state: previousEntry?.state === 'conflict' ? 'conflict' : 'synced',
      updatedAt: new Date().toISOString(),
      local: localEntryToState(localFile),
      remote: remoteEntry ? remoteEntryToState(remoteEntry) : (previousEntry.remote || null),
    };
  }

  emit({ type: 'status', phase: 'complete', message: 'Sync completed.' });

  return {
    uploaded,
    downloaded,
    foldersCreated: Array.from(foldersCreated),
    skipped,
    warnings,
    conflicts,
    remoteFilesCount: remoteFiles.length,
    remoteFoldersCount: remoteFolders.length,
    remoteCount: remoteFiles.length,
    localCount: localFiles.length,
    totalOperations,
    completedOperations,
    syncStateEntries,
    pendingOps,
    live,
    finishedAt: new Date().toISOString(),
  };
}

module.exports = {
  runSync,
};
