const DEFAULT_PAGE_SIZE = 1000;
const API_SUFFIXES = ['/api/v1'];
const NETWORK_RETRY_DELAYS_MS = [0, 750, 1500];
const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
let undiciDispatcher = null;
const OPENAPI_HINT_PATTERN = /(\/swagger\.(json|ya?ml)|\/swaggerrigtig\.(json|ya?ml)|\/openapi\.(json|ya?ml)|\/api-docs(?:\/.*)?|\/docs(?:\/.*)?)$/i;

function getUndiciDispatcher() {
  if (undiciDispatcher !== null) return undiciDispatcher || undefined;
  try {
    const { Agent } = require('undici');
    undiciDispatcher = new Agent({
      connectTimeout: 30000,
      headersTimeout: 60000,
      bodyTimeout: 60000,
    });
    return undiciDispatcher;
  } catch {
    undiciDispatcher = false;
    return undefined;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function normalizeBaseUrl(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Base URL is missing. Enter e.g. https://boltbytes.com or the URL to the swagger file.');
  }

  let parsed;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new Error('Base URL is invalid. Use a full URL such as https://boltbytes.com.');
  }

  // Users often paste the OpenAPI server URL (https://host/api/v1) or a swagger.yaml URL.
  // Our client appends API_SUFFIXES itself, so we strip any trailing /api/v1 to avoid /api/v1/api/v1.
  let cleanedPath = stripTrailingSlash(parsed.pathname || '');
  cleanedPath = cleanedPath.replace(OPENAPI_HINT_PATTERN, '');

  for (const suffix of API_SUFFIXES) {
    const normalizedSuffix = stripTrailingSlash(suffix);
    const suffixRegex = new RegExp(`${normalizedSuffix.replaceAll('/', '\/')}$`, 'i');
    cleanedPath = cleanedPath.replace(suffixRegex, '');
  }

  const baseOrigin = `${parsed.origin}${cleanedPath}`;
  return stripTrailingSlash(baseOrigin);
}


async function readErrorBody(response) {
  const contentType = response.headers.get('content-type') || '';
  const body = await response.text();
  if (contentType.includes('text/html')) {
    const titleMatch = body.match(/<h1[^>]*>(.*?)<\/h1>/i) || body.match(/<title[^>]*>(.*?)<\/title>/i);
    const summary = titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim();
    return summary ? `${summary} (HTML error from the server)` : 'The server returned HTML instead of JSON.';
  }

  return body;
}

function extractUser(payload) {
  return payload?.user || payload?.data?.user || null;
}

function extractAccessToken(payload, headers = null) {
  const bodyCandidates = [
    payload?.access_token,
    payload?.accessToken,
    payload?.token,
    payload?.plainTextToken,
    payload?.user?.access_token,
    payload?.user?.accessToken,
    payload?.data?.access_token,
    payload?.data?.accessToken,
    payload?.data?.token,
    payload?.data?.plainTextToken,
    payload?.data?.user?.access_token,
    payload?.data?.user?.accessToken,
    payload?.meta?.access_token,
    payload?.meta?.accessToken,
    payload?.meta?.token,
  ];

  for (const candidate of bodyCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  if (headers) {
    const headerCandidates = [
      headers.get('authorization'),
      headers.get('x-authorization'),
      headers.get('x-auth-token'),
      headers.get('x-access-token'),
    ];

    for (const candidate of headerCandidates) {
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const normalized = candidate.replace(/^Bearer\s+/i, '').trim();
      if (normalized) return normalized;
    }
  }

  return null;
}

function isFolderEntry(entry) {
  const type = String(entry?.type || '').toLowerCase();
  const mime = String(entry?.mime || entry?.mime_type || '').toLowerCase();
  return Boolean(
    entry?.isFolder
    || type === 'folder'
    || type === 'directory'
    || type === 'dir'
    || mime === 'folder'
    || mime === 'directory'
    || mime === 'application/x-directory'
  );
}

function normalizeFolderPath(folderPath, fallbackName = 'Folder') {
  if (typeof folderPath !== 'string') return fallbackName;
  const trimmed = folderPath.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed || fallbackName;
}

function normalizeRemoteFolder(entry, inherited = {}) {
  const name = String(entry?.name || entry?.filename || inherited.name || 'Folder').trim() || 'Folder';
  const entryId = entry?.id ?? entry?.file_entry_id ?? entry?.fileEntryId ?? inherited.id ?? '';
  const rawPath = entry?.path ?? entry?.relative_path ?? entry?.relativePath ?? inherited.path ?? name;
  const normalizedPath = normalizeFolderPath(rawPath, name);
  const looksNumeric = /^\d+$/.test(normalizedPath);
  const displayLabel = !normalizedPath || normalizedPath === name || looksNumeric ? name : normalizedPath;

  return {
    id: entryId === undefined || entryId === null ? '' : String(entryId),
    name,
    path: normalizedPath,
    displayLabel,
    parentId: entry?.parent_id ?? entry?.parentId ?? inherited.parentId ?? '',
    backendId: entry?.backend_id ?? entry?.backendId ?? entry?.storage_id ?? entry?.storageId ?? inherited.backendId ?? '',
  };
}

function dedupeFoldersById(folders = []) {
  const seen = new Set();
  const result = [];
  for (const folder of folders) {
    const id = folder?.id === undefined || folder?.id === null ? '' : String(folder.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(folder);
  }
  return result;
}



function getFolderSortLabel(folder) {
  const label =
    folder?.displayLabel ??
    folder?.path ??
    folder?.name ??
    folder?.file_name ??
    folder?.fileName ??
    folder?.id ??
    '';
  return String(label).trim();
}

function appendSearchParams(pathname, params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        search.append(key, String(item));
      }
      continue;
    }

    search.append(key, String(value));
  }

  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function normalizeRelativePath(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
}


const ROOT_PARENT_ID_MARKERS = new Set(['', '0', 'null', 'undefined', '__root__', 'root', '/']);

function normalizeParentIdValue(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  return ROOT_PARENT_ID_MARKERS.has(normalized) ? '' : normalized;
}

function extractEntryFromPayload(payload) {
  const candidates = [
    payload,
    payload?.data,
    payload?.fileEntry,
    payload?.file_entry,
    payload?.entry,
    payload?.item,
    payload?.upload,
    payload?.data?.fileEntry,
    payload?.data?.file_entry,
    payload?.data?.entry,
    payload?.data?.item,
    payload?.data?.upload,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object') {
      const id = candidate.id ?? candidate.file_entry_id ?? candidate.fileEntryId ?? candidate.entry_id ?? candidate.entryId;
      if (id !== undefined && id !== null && id !== '') return candidate;
    }
  }

  return null;
}

function parseTimestamp(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}


function isRetriableNetworkError(error) {
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const message = String(error.message || '').toLowerCase();
  const causeCode = String(error?.cause?.code || error?.code || '').toUpperCase();
  return (
    causeCode.startsWith('UND_ERR_')
    || causeCode === 'ECONNRESET'
    || causeCode === 'ECONNREFUSED'
    || causeCode === 'ENOTFOUND'
    || causeCode === 'ETIMEDOUT'
    || causeCode === 'EAI_AGAIN'
    || message.includes('fetch failed')
    || message.includes('connect timeout')
    || message.includes('timed out')
  );
}

function describeNetworkError(error, url) {
  const causeCode = String(error?.cause?.code || error?.code || '').toUpperCase();
  const causeMessage = String(error?.cause?.message || '').trim();
  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT' || /connect timeout/i.test(causeMessage)) {
    return `Could not connect to ${url} within the timeout. Check your internet, firewall/VPN/proxy, and that ${new URL(url).origin} is reachable from this PC.`;
  }
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return `Could not resolve hostname for ${url}. Check DNS / internet connection.`;
  }
  if (causeCode === 'ECONNREFUSED') {
    return `Connection to ${url} was refused. Check the server base URL and that the API is online.`;
  }
  return `Network error contacting ${url}: ${error.message || 'Unknown error'}`;
}

class BoltBytesClient {
  constructor({ baseUrl, token = '', debug = null }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.debug = typeof debug === 'function' ? debug : null;
  }

  buildCandidateUrls(pathname) {
    return API_SUFFIXES.map(suffix => `${this.baseUrl}${suffix}${pathname}`);
  }

  async request(pathname, options = {}) {
    const headers = {
      Accept: 'application/json',
      ...options.headers,
    };

    if (this.token && !headers.Authorization) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const candidateUrls = this.buildCandidateUrls(pathname);
    let lastError;

    for (const url of candidateUrls) {
      for (let attemptIndex = 0; attemptIndex < NETWORK_RETRY_DELAYS_MS.length; attemptIndex += 1) {
        const retryDelayMs = NETWORK_RETRY_DELAYS_MS[attemptIndex];
        if (retryDelayMs) await delay(retryDelayMs);

        this.debug?.({
          phase: 'request',
          url,
          pathname,
          method: options.method || 'GET',
          attempt: attemptIndex + 1,
        });

        try {
          const response = await fetch(url, {
            ...options,
            headers,
            signal: options.signal || AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
            dispatcher: getUndiciDispatcher(),
          });

          const contentType = response.headers.get('content-type') || '';

          if (response.ok) {
            if (contentType.includes('application/json')) {
              const payload = await response.json();
              this.debug?.({
                phase: 'response',
                url,
                status: response.status,
                ok: true,
                attempt: attemptIndex + 1,
                bodySnippet: JSON.stringify(payload).slice(0, 2000),
              });
              return payload;
            }

            this.debug?.({ phase: 'response', url, status: response.status, ok: true, attempt: attemptIndex + 1 });
            return response;
          }

          const body = await readErrorBody(response);
          this.debug?.({
            phase: 'response',
            url,
            status: response.status,
            ok: false,
            attempt: attemptIndex + 1,
            bodySnippet: String(body || '').slice(0, 2000),
          });
          const error = new Error(`API ${response.status} ${response.statusText} at ${url}: ${body}`);
          error.status = response.status;
          error.url = url;
          error.body = body;
          lastError = error;

          if (response.status !== 404 && response.status !== 405) {
            throw error;
          }
          break;
        } catch (error) {
          if (!isRetriableNetworkError(error) || attemptIndex === NETWORK_RETRY_DELAYS_MS.length - 1) {
            if (isRetriableNetworkError(error)) {
              const wrapped = new Error(describeNetworkError(error, url));
              wrapped.url = url;
              wrapped.cause = error;
              this.debug?.({
                phase: 'network-error',
                url,
                pathname,
                attempt: attemptIndex + 1,
                error: wrapped.message,
              });
              throw wrapped;
            }
            throw error;
          }

          this.debug?.({
            phase: 'network-retry',
            url,
            pathname,
            attempt: attemptIndex + 1,
            error: String(error?.message || error),
          });
        }
      }
    }

    if (lastError) {
      if (lastError.status === 405) {
        throw new Error(`${lastError.message}. Tip: use the site root as the base URL, e.g. https://boltbytes.com, not a specific swagger/openapi page.`);
      }
      throw lastError;
    }

    throw new Error(`Could not call the API for ${pathname}.`);
  }

  async login({ email, password, tokenName = 'BoltBytes Sync Desktop' }) {
    const candidateUrls = this.buildCandidateUrls('/auth/login');
    let lastError;

    for (const url of candidateUrls) {
      for (let attemptIndex = 0; attemptIndex < NETWORK_RETRY_DELAYS_MS.length; attemptIndex += 1) {
        const retryDelayMs = NETWORK_RETRY_DELAYS_MS[attemptIndex];
        if (retryDelayMs) await delay(retryDelayMs);

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email,
              password,
              token_name: tokenName,
            }),
            signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
            dispatcher: getUndiciDispatcher(),
          });

          if (!response.ok) {
            const body = await readErrorBody(response);
            lastError = new Error(`API ${response.status} ${response.statusText} at ${url}: ${body}`);
            if (response.status !== 404 && response.status !== 405) throw lastError;
            break;
          }

          const contentType = response.headers.get('content-type') || '';
          let payload = {};
          if (contentType.includes('application/json')) {
            payload = await response.json();
          } else {
            const body = await response.text();
            try {
              payload = JSON.parse(body);
            } catch {
              payload = { raw: body };
            }
          }

          const token = extractAccessToken(payload, response.headers);
          if (!token) {
            throw new Error('Login failed: the API did not return an access token.');
          }

          this.token = token;
          return {
            token,
            user: extractUser(payload),
            raw: payload,
          };
        } catch (error) {
          if (!isRetriableNetworkError(error) || attemptIndex === NETWORK_RETRY_DELAYS_MS.length - 1) {
            if (isRetriableNetworkError(error)) {
              throw new Error(describeNetworkError(error, url));
            }
            throw error;
          }
        }
      }
    }

    if (lastError) throw lastError;
    throw new Error('Login failed: could not reach the auth endpoint.');
  }

  unwrapCollectionPayload(payload) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.pagination?.data)) return payload.pagination.data;
    if (Array.isArray(payload?.pagination?.items)) return payload.pagination.items;
    if (Array.isArray(payload?.items)) return payload.items;
    return [];
  }

  async listRemoteEntries({ remoteFolderId = '', parentId = remoteFolderId, perPage = DEFAULT_PAGE_SIZE, workspaceId = 0 } = {}) {
    const normalizedParentId = normalizeParentIdValue(parentId);
    const isRootListing = normalizedParentId === '';

    const buildPath = (basePath, parentValue) => {
      const isDriveListing = basePath.startsWith('/drive/');
      const parentParams = parentValue === ''
        ? {}
        : (isDriveListing ? { parentIds: [parentValue] } : { parentId: parentValue });

      return appendSearchParams(basePath, {
        perPage,
        workspaceId,
        ...parentParams,
      });
    };

    // Swagger UI shows Drive listing uses `parentIds[]=...` (exploded query), while FileEntries uses `parentId`.
    // We prefer the Drive endpoint first, then fall back.
    const candidatePaths = [
      buildPath('/drive/file-entries', normalizedParentId),
      buildPath('/file-entries', normalizedParentId),
    ];

    const getEntryId = entry => {
      const rawId = entry?.id ?? entry?.file_entry_id ?? entry?.fileEntryId;
      return rawId === undefined || rawId === null ? '' : String(rawId).trim();
    };

    const getEntryParentId = entry => {
      const rawParentId = entry?.parent_id ?? entry?.parentId ?? entry?.parent?.id ?? entry?.parent?.file_entry_id ?? '';
      return rawParentId === undefined || rawParentId === null ? '' : String(rawParentId).trim();
    };

    const getEntryPath = entry => {
      const rawPath = entry?.path ?? entry?.relativePath ?? entry?.relative_path ?? '';
      return rawPath === undefined || rawPath === null ? '' : String(rawPath).trim();
    };

    const looksLikeUnfilteredRoot = entries => {
      if (isRootListing || !normalizedParentId) return false;
      if (!Array.isArray(entries) || entries.length === 0) return false;

      const hasParentMatches = entries.some(entry => getEntryParentId(entry) === normalizedParentId);
      if (hasParentMatches) return false;

      const hasSelf = entries.some(entry => getEntryId(entry) === normalizedParentId);
      const hasSiblingRoot = entries.some(entry => {
        const entryId = getEntryId(entry);
        if (!entryId || entryId === normalizedParentId) return false;
        const entryParentId = getEntryParentId(entry);
        const entryPath = getEntryPath(entry);
        return ROOT_PARENT_ID_MARKERS.has(entryParentId) && (entryPath === '' || entryPath === entryId);
      });

      return hasSelf || hasSiblingRoot;
    };

    const canTrustServerFiltering = entries => {
      if (isRootListing || !normalizedParentId) return false;
      if (!Array.isArray(entries) || entries.length === 0) return false;

      // If parent_id is missing, we can still infer from path like "4044/5924" (parent id chain).
      const prefix = `${normalizedParentId}/`;
      return entries.some(entry => {
        const entryPath = getEntryPath(entry);
        return entryPath.startsWith(prefix) || entryPath.includes(prefix);
      });
    };

    let lastError;
    for (const pathname of candidatePaths) {
      try {
        const payload = await this.request(pathname);
        const entries = this.unwrapCollectionPayload(payload);
        if (!Array.isArray(entries)) return [];

        if (isRootListing) {
          return entries.filter(entry => {
            const entryId = getEntryId(entry);
            const entryParentId = getEntryParentId(entry);
            if (entryId && ROOT_PARENT_ID_MARKERS.has(entryId)) return false;
            return ROOT_PARENT_ID_MARKERS.has(entryParentId);
          });
        }

        const filtered = entries.filter(entry => {
          const entryId = getEntryId(entry);
          const entryParentId = getEntryParentId(entry);
          if (entryId === normalizedParentId) return false;
          return entryParentId === normalizedParentId;
        });

        if (filtered.length) return filtered;
        if (entries.length === 0) return [];

        // If this response looks like the API ignored parentId, try next endpoint.
        if (looksLikeUnfilteredRoot(entries)) {
          this.debug?.({ phase: 'tree', action: 'fallback', reason: 'unfiltered-root', pathname, parentId: normalizedParentId });
          continue;
        }

        // Some responses omit parent_id but still represent children; trust the server if path indicates nesting.
        if (canTrustServerFiltering(entries)) {
          return entries.filter(entry => getEntryId(entry) !== normalizedParentId);
        }

        // Otherwise treat as no children (prevents queuing sibling root folders by mistake).
        return [];
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 && error?.status !== 405) throw error;
      }
    }

    if (lastError) throw lastError;
    return [];
  }




  async listRemoteTree({ parentId = '', workspaceId = 0 } = {}) {
    const rootParentId = normalizeParentIdValue(parentId);
    const visitedFolderIds = new Set(rootParentId ? [rootParentId] : []);
    const folders = new Map();
    const files = [];
    const queue = [{ parentId: rootParentId, pathPrefix: '', backendId: '' }];

    while (queue.length) {
      const current = queue.shift();
      this.debug?.({ phase: 'tree', action: 'list', parentId: current.parentId, pathPrefix: current.pathPrefix, workspaceId, queue: queue.length });
      const entries = await this.listRemoteEntries({ parentId: current.parentId, workspaceId });
      for (const entry of entries) {
        const rawId = entry?.id ?? entry?.file_entry_id ?? entry?.fileEntryId;
        const entryId = rawId === undefined || rawId === null ? '' : String(rawId);
        const entryName = String(entry?.name || entry?.file_name || entry?.fileName || entry?.filename || entry?.original_name || 'Unknown').trim() || 'Unknown';
        const relativePath = normalizeRelativePath([current.pathPrefix, entryName].filter(Boolean).join('/'));
        const backendId = entry?.backend_id ?? entry?.backendId ?? entry?.storage_id ?? entry?.storageId ?? current.backendId ?? '';

        if (isFolderEntry(entry)) {
          if (!entryId || visitedFolderIds.has(entryId)) continue;
          visitedFolderIds.add(entryId);
          const folder = normalizeRemoteFolder(entry, {
            name: entryName,
            path: relativePath || entryName,
            parentId: current.parentId,
            backendId,
          });
          folder.path = relativePath || entryName;
          folder.displayLabel = folder.path || entryName;
          folders.set(folder.id, folder);
          queue.push({ parentId: folder.id, pathPrefix: folder.path, backendId: folder.backendId || backendId });
        } else {
          files.push({
            ...entry,
            id: entryId || entry.id,
            name: entryName,
            parentId: entry?.parent_id ?? entry?.parentId ?? current.parentId,
            backendId,
            relativePath,
            fileSize: Number(entry?.file_size ?? entry?.size ?? 0) || 0,
            updatedAtMs: parseTimestamp(entry?.updated_at || entry?.updatedAt),
          });
        }
      }
      this.debug?.({ phase: 'tree', action: 'batch', parentId: current.parentId, entries: entries.length, folders: folders.size, files: files.length, queue: queue.length });
    }

    return {
      folders: [...folders.values()].sort((a, b) => a.displayLabel.localeCompare(b.displayLabel, 'en')),
      files,
    };
  }

  async listRemoteFolders({ workspaceId = 0 } = {}) {
    const rootFolder = {
      id: '__root__',
      name: 'Root (/)',
      path: '',
      displayLabel: 'Root (/)',
      parentId: '',
      backendId: '',
    };

    const rootEntries = await this.listRemoteEntries({ parentId: '', workspaceId, perPage: DEFAULT_PAGE_SIZE });

    const normalizedRootFolders = dedupeFoldersById(
      (Array.isArray(rootEntries) ? rootEntries : [])
        .filter(entry => {
          const type = String(entry?.type || '').toLowerCase();
          return isFolderEntry(entry) || (!type || type === 'folder' || type === 'directory' || type === 'dir');
        })
        .map(entry => normalizeRemoteFolder(entry, {
          name: entry?.name || entry?.file_name || entry?.fileName || entry?.filename || 'Folder',
          path: entry?.name || entry?.file_name || entry?.fileName || entry?.filename || 'Folder',
          parentId: entry?.parent_id ?? entry?.parentId ?? '',
          backendId: entry?.backend_id ?? entry?.backendId ?? entry?.storage_id ?? entry?.storageId ?? '',
        })),
    );

    if (normalizedRootFolders.length) {
      const sorted = normalizedRootFolders.sort((a, b) => getFolderSortLabel(a).localeCompare(getFolderSortLabel(b), 'en'));
      return [rootFolder, ...sorted];
    }

    const tree = await this.listRemoteTree({ parentId: '', workspaceId });
    const sorted = dedupeFoldersById(tree.folders).sort((a, b) => getFolderSortLabel(a).localeCompare(getFolderSortLabel(b), 'en'));
    return [rootFolder, ...sorted];
  }



async listRemoteFolderChildren({ parentId = '', workspaceId = 0, perPage = DEFAULT_PAGE_SIZE } = {}) {
  const entries = await this.listRemoteEntries({ parentId, workspaceId, perPage });
  const normalized = dedupeFoldersById(
    (Array.isArray(entries) ? entries : [])
      .filter(entry => isFolderEntry(entry) || String(entry?.type || '').toLowerCase() === 'folder')
      .map(entry => normalizeRemoteFolder(entry, {
        name: entry?.name || entry?.file_name || entry?.fileName || entry?.filename || 'Folder',
        path: entry?.name || entry?.file_name || entry?.fileName || entry?.filename || 'Folder',
        parentId: entry?.parent_id ?? entry?.parentId ?? parentId ?? '',
        backendId: entry?.backend_id ?? entry?.backendId ?? entry?.storage_id ?? entry?.storageId ?? '',
      })),
  );

  return normalized.sort((a, b) => getFolderSortLabel(a).localeCompare(getFolderSortLabel(b), 'en'));
}  async createRemoteFolder({ name, parentId = '', workspaceId = 0 } = {}) {
    const folderName = String(name || '').trim();
    if (!folderName) {
      throw new Error('Folder name is required.');
    }

    const normalizedParentId = normalizeParentIdValue(parentId);
    const parentValue = normalizedParentId === '' ? null : normalizedParentId;

    const jsonAttempts = [
      { name: folderName, type: 'folder', parentId: parentValue, workspaceId },
      { name: folderName, entryType: 'folder', parentId: parentValue, workspaceId },
      { name: folderName, type: 'folder', parent_id: parentValue, workspaceId },
      { name: folderName, parentId: parentValue, workspaceId, uploadType: 'bedrive', type: 'folder' },
      { name: folderName, parent_id: parentValue, workspaceId, uploadType: 'bedrive', type: 'folder' },
    ];

    let lastError;
    for (const body of jsonAttempts) {
      try {
        return await this.request('/file-entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        if (![404, 405, 415, 422].includes(Number(error?.status))) throw error;
      }
    }

    const multipartAttempts = [
      { relativePath: folderName, type: 'folder' },
      { relativePath: `${folderName}/`, type: 'folder' },
      { relativePath: folderName, folder: 'true' },
      { relativePath: `${folderName}/`, folder: 'true' },
    ];

    for (const fields of multipartAttempts) {
      try {
        const FormDataCtor = globalThis.FormData || require('undici').FormData;
        const form = new FormDataCtor();
        form.append('uploadType', 'bedrive');
        form.append('workspaceId', String(workspaceId));
        if (parentValue) form.append('parentId', String(parentValue));
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined || value === null) continue;
          form.append(key, String(value));
        }
        return await this.request('/file-entries', { method: 'POST', body: form });
      } catch (error) {
        lastError = error;
        if (![404, 405, 415, 422].includes(Number(error?.status))) throw error;
      }
    }

    throw lastError || new Error('Could not create folder.');
  }



  async uploadFile({ fileName, contentType, buffer, uploadType = 'bedrive', backendId, parentId = '', clientExtension = '', relativePath = '', workspaceId = 0 }) {
    const attempts = [
      { path: '/uploads', requireBackend: false },
      { path: '/uploads', requireBackend: true },
      { path: '/file-entries', requireBackend: false },
      { path: '/file-entries', requireBackend: true },
    ];

    let lastError;
    for (const attempt of attempts) {
      if (attempt.requireBackend && !backendId) continue;

      const FormDataCtor = globalThis.FormData || require('undici').FormData;
        const form = new FormDataCtor();
      const blob = new Blob([buffer], { type: contentType || 'application/octet-stream' });
      form.append('file', blob, fileName);
      form.append('uploadType', uploadType);
      form.append('clientMime', contentType || 'application/octet-stream');
      if (clientExtension) form.append('clientExtension', clientExtension);
      if (parentId) form.append('parentId', parentId);
      if (relativePath) form.append('relativePath', normalizeRelativePath(relativePath));
      if (backendId) form.append('backendId', backendId);
      form.append('workspaceId', String(workspaceId));

      try {
        const payload = await this.request(attempt.path, {
          method: 'POST',
          body: form,
          headers: {
            Accept: 'application/json',
          },
        });
        const entry = extractEntryFromPayload(payload);
        return { payload, entry };
      } catch (error) {
        lastError = error;
        const body = String(error?.body || error?.message || '').toLowerCase();
        const backendRequired = body.includes('backendid') || body.includes('backend id');
        if (backendRequired && !backendId && !attempt.requireBackend) {
          continue;
        }
        if (error?.status !== 404 && error?.status !== 405) throw error;
      }
    }

    if (lastError) throw lastError;
    throw new Error('Upload could not be completed.');
  }



  async listDeletedEntries({ perPage = DEFAULT_PAGE_SIZE, workspaceId = 0 } = {}) {
    const candidatePaths = [
      appendSearchParams('/file-entries', { perPage, workspaceId, deletedOnly: true }),
      appendSearchParams('/drive/file-entries', { perPage, workspaceId, deletedOnly: true }),
      appendSearchParams('/file-entries', { perPage, workspaceId, deletedOnly: 'true' }),
      appendSearchParams('/drive/file-entries', { perPage, workspaceId, deletedOnly: 'true' }),
    ];

    let lastError;
    for (const pathname of candidatePaths) {
      try {
        const payload = await this.request(pathname);
        const entries = this.unwrapCollectionPayload(payload);
        const filtered = entries.filter(entry => Boolean(entry?.deleted_at || entry?.deletedAt));
        if (filtered.length) return filtered;
        if (entries.length === 0) return [];
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 && error?.status !== 405) throw error;
      }
    }

    if (lastError) throw lastError;
    return [];
  }

  async restoreEntries(entryIds = []) {
    const ids = [...new Set((entryIds || []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('No deleted entries selected for restore.');
    const attempts = [
      { entryIds: ids },
      { ids },
      { entries: ids },
      { entryIds: ids.map(Number).filter(Number.isFinite) },
      { ids: ids.map(Number).filter(Number.isFinite) },
      { entryId: ids[0] },
      { id: ids[0] },
    ];

    let lastError;
    for (const body of attempts) {
      try {
        return await this.request('/file-entries/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 && error?.status !== 405 && error?.status !== 422) throw error;
      }
    }
    throw lastError || new Error('Could not restore deleted entries.');
  }

  /**
   * Move entries to Trash or delete them permanently.
   *
   * The primary API expects: { entryIds: string[], deleteForever: boolean }.
   * This client also sends a few legacy fallbacks for older servers.
   */
  async deleteEntries(entryIds = [], { deleteForever = false, permanent } = {}) {
    const resolvedDeleteForever = typeof deleteForever === 'boolean' ? deleteForever : Boolean(permanent);
    const ids = [...new Set((entryIds || []).map(value => String(value || '').trim()).filter(Boolean))];
    if (!ids.length) throw new Error('No entries selected for delete.');

    const numericIds = ids.map(Number).filter(Number.isFinite);

    const jsonBodies = [
      { entryIds: ids, deleteForever: resolvedDeleteForever },
      ...(numericIds.length ? [{ entryIds: numericIds, deleteForever: resolvedDeleteForever }] : []),

      // Legacy / compatibility shapes.
      { entryIds: ids, deleteForever: resolvedDeleteForever, permanent: resolvedDeleteForever },
      { entryIds: ids, delete_forever: resolvedDeleteForever },
      { ids, deleteForever: resolvedDeleteForever },
      ...(numericIds.length ? [{ ids: numericIds, deleteForever: resolvedDeleteForever }] : []),
      { ids, permanent: resolvedDeleteForever },
      { entries: ids, deleteForever: resolvedDeleteForever },
    ];

    let lastError;
    for (const body of jsonBodies) {
      try {
        return await this.request('/file-entries/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 && error?.status !== 405 && error?.status !== 422) throw error;
      }
    }

    for (const id of ids) {
      try {
        return await this.request(`/file-entries/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (error) {
        lastError = error;
        if (error?.status !== 404 && error?.status !== 405 && error?.status !== 422) throw error;
      }
    }

    throw lastError || new Error('Unable to delete selected entries.');
  }




async downloadFileRange(entry, { offset = 0, length = 0 } = {}) {
  const candidates = this.inferDownloadUrls(entry);
  if (!candidates.length) {
    throw new Error(`No download URL found for remote file "${entry?.name || entry?.id || 'Unknown'}".`);
  }

  const wantRange = Number.isFinite(offset) && offset >= 0 && Number.isFinite(length) && length > 0;
  const rangeHeader = wantRange ? `bytes=${Math.floor(offset)}-${Math.floor(offset + length - 1)}` : null;

  let lastError;
  for (const candidate of candidates) {
    const urls = candidate.startsWith('http') ? [candidate] : this.buildCandidateUrls(candidate);

    for (const url of urls) {
      const headers = { Authorization: `Bearer ${this.token}` };
      if (rangeHeader) headers.Range = rangeHeader;

      const response = await fetch(url, { headers });
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        let buf = Buffer.from(arrayBuffer);
        if (wantRange && response.status !== 206) {
          buf = buf.subarray(0, length);
        }
        return buf;
      }

      lastError = new Error(`Download failed for "${entry?.name || entry?.id || 'file'}": ${response.status} ${response.statusText} at ${url}`);
      if (response.status !== 404 && response.status !== 405) {
        throw lastError;
      }
    }
  }

  throw lastError || new Error(`Download failed for "${entry?.name || entry?.id || 'file'}".`);
}

  async downloadFile(entry) {
    const candidates = this.inferDownloadUrls(entry);
    if (!candidates.length) {
      throw new Error(`No download URL found for remote file "${entry.name}".`);
    }

    let lastError;
    for (const candidate of candidates) {
      const urls = candidate.startsWith('http') ? [candidate] : this.buildCandidateUrls(candidate);

      for (const url of urls) {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${this.token}`,
          },
        });

        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          return Buffer.from(arrayBuffer);
        }

        lastError = new Error(`Download failed for "${entry.name}": ${response.status} ${response.statusText} at ${url}`);
        if (response.status !== 404 && response.status !== 405) {
          throw lastError;
        }
      }
    }

    throw lastError || new Error(`Download failed for "${entry.name}".`);
  }

  inferDownloadUrls(entry) {
    const explicitCandidates = [
      entry.url,
      entry.download_url,
      entry.downloadUrl,
      entry.file_url,
    ].filter(value => typeof value === 'string' && value.trim())
      .filter(value => value.startsWith('http') || value.startsWith('/'));

    const entryId = entry.id ?? entry.file_entry_id ?? entry.fileEntryId;
    const hashes = entry.hash || entry.file_hash || entry.fileHash;
    if (hashes) {
      explicitCandidates.push(`/file-entries/download/${hashes}`);
    }
    if (entryId) {
      explicitCandidates.push(`/file-entries/${entryId}?download=1`);
      explicitCandidates.push(`/file-entries/${entryId}/download`);
      explicitCandidates.push(`/drive/file-entries/${entryId}/download`);
    }

    return [...new Set(explicitCandidates)];
  }

  inferDownloadUrl(entry) {
    return this.inferDownloadUrls(entry)[0] || null;
  }
}

module.exports = {
  BoltBytesClient,
  normalizeBaseUrl,
};
