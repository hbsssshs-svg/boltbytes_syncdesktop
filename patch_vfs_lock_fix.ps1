// src/main.js

async function stopVfsProvider() {
  vfsProviderStopRequested = true;
  vfsProviderRestartAttempts = 0;

  if (vfsProviderRestartTimer) {
    try { clearTimeout(vfsProviderRestartTimer); } catch {}
    vfsProviderRestartTimer = null;
  }

  const proc = vfsProviderProcess;
  vfsProviderProcess = null;

  vfsProviderState.running = false;
  vfsProviderState.lastExitCode = null;
  vfsProviderState.lastEventAt = Date.now();
  publishVfsStatus();

  if (!proc) return;

  await new Promise(resolve => {
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try { proc.removeListener('exit', finish); } catch {}
      try { proc.removeListener('close', finish); } catch {}
      resolve();
    };

    proc.once('exit', finish);
    proc.once('close', finish);

    try {
      proc.kill();
    } catch {
      finish();
      return;
    }

    setTimeout(finish, 5000);
  });
}

async function configureVfsInfrastructure(config) {
  if (process.platform !== 'win32') return;

  const enabled = Boolean(config?.virtualFilesEnabled);
  if (!enabled) {
    vfsActiveConfig = null;
    await stopVfsProvider();
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

  if (vfsProviderProcess || vfsProviderStarting) return;

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
    vfsProviderStarting = true;
    vfsProviderStopRequested = false;
    vfsProviderStartedAt = Date.now();

    if (vfsProviderRestartTimer) {
      try { clearTimeout(vfsProviderRestartTimer); } catch {}
      vfsProviderRestartTimer = null;
    }

    vfsProviderProcess = require('node:child_process').spawn(launch.cmd, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    vfsProviderStarting = false;
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
      vfsProviderStarting = false;
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
        vfsProviderState.lastError = `Provider exited with ${details}`;
      }

      publishVfsStatus();
      vfsProviderProcess = null;
      vfsProviderStarting = false;

      const abnormalExit =
        !requested &&
        (
          Boolean(signal) ||
          (typeof code === 'number' && code !== 0)
        );

      if (abnormalExit && vfsActiveConfig?.virtualFilesEnabled && vfsActiveConfig?.virtualFilesFolder && vfsActiveConfig?.remoteFolderId) {
        if (runtimeMs > 60_000) vfsProviderRestartAttempts = 0;
        vfsProviderRestartAttempts = Math.min(vfsProviderRestartAttempts + 1, 6);

        const delayMs = Math.min(30_000, 1500 * (2 ** vfsProviderRestartAttempts));

        if (vfsProviderRestartTimer) {
          try { clearTimeout(vfsProviderRestartTimer); } catch {}
        }

        vfsProviderRestartTimer = setTimeout(() => {
          vfsProviderRestartTimer = null;
          configureVfsInfrastructure(vfsActiveConfig).catch(err => {
            addActivity({ level: 'warning', message: `[Cloud Files] Auto-restart failed: ${String(err?.message || err)}` });
          });
        }, delayMs);

        addActivity({ level: 'info', message: `[Cloud Files] Auto-restart scheduled in ${Math.round(delayMs / 1000)}s.` });
      } else {
        vfsProviderRestartAttempts = 0;
      }
    });
  } catch (err) {
    vfsProviderStarting = false;
    const msg = String(err?.message || err);
    addActivity({ level: 'warning', message: `[Cloud Files] Failed to start provider: ${msg}` });
    vfsProviderState.running = false;
    vfsProviderState.lastError = msg;
    vfsProviderState.lastExitCode = null;
    vfsProviderState.lastEventAt = Date.now();
    publishVfsStatus();
  }
}