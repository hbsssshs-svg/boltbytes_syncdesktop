Cloud Files rebuild patch

What changed
- Rebuilt the Windows Cloud Files provider lifecycle in src/main.js.
- Dev mode now launches ONLY a prebuilt BoltBytesVfsProvider.exe.
- Removed the Electron-side dotnet run fallback that caused CS2012 DLL locks.
- Added persistent debug logging to userData\cloud-files-provider-debug.log.
- Disabled auto-restart logic for now to eliminate duplicate-instance loops.
- Fixed VFS request id handling so id = 0 is accepted.

How to use
1. Replace src/main.js with main_cloud_files_rebuilt.js
   OR run:
   powershell -ExecutionPolicy Bypass -File .\apply_cloud_files_rebuild_patch.ps1

2. Build the provider manually once:
   cd native\windows\BoltBytesVfsProvider
   dotnet clean
   dotnet build

3. Start the app from the repo root:
   npm start

What to send back if it still fails
- The exact Cloud Files log lines around the failure
- The file at:
  <Electron userData>\cloud-files-provider-debug.log

Expected result
- Electron no longer triggers dotnet run for the provider in dev.
- Any remaining failure should now be visible as a normal process launch/runtime problem instead of a CS2012 rebuild race.
