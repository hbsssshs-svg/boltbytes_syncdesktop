# BoltBytesVfsProvider (Windows)

This is an MVP Cloud Files (Files-on-Demand) provider helper for BoltBytes Sync Desktop.

## Build

```powershell
cd native/windows/BoltBytesVfsProvider
dotnet build -c Release
```

## Run (dev)

The Electron app can run it automatically via `dotnet run` when **Cloud Files (Windows)** is enabled in Settings.

If you want to run it manually:

```powershell
dotnet run --project . -- `
  --syncRoot "C:\BoltBytes Cloud Files" `
  --pipeName "boltbytes-syncdesktop-vfs-xxxxxxxxxx" `
  --remoteFolderId "<your-cloud-folder-id>" `
  --workspaceId 0 `
  --providerId "4f6d0c5e-7c2f-4d9b-a7e0-75b9385c00b2" `
  --providerName "BoltBytes Desktop"
```

## Availability in Explorer

Windows shows **Always keep on this device** / **Free up space** automatically for cloud file placeholders.

This helper monitors the pinned/unpinned file attributes and will hydrate/dehydrate files accordingly. 
