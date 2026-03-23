using System.Buffers;
using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace BoltBytesVfsProvider;

internal static class Program
{
    private static System.Threading.Mutex? _singleInstanceMutex;

    private const string DefaultProviderName = "BoltBytes Desktop";
    private const string DefaultProviderVersion = "0.2.5";

    private static PipeRpcClient? _rpc;
    private static ProviderRuntime? _provider;

    private static string FormatExceptionOneLine(Exception ex)
    {
        var hresult = ex.HResult;
        var msg = ex.Message?.Replace('\r', ' ').Replace('\n', ' ') ?? string.Empty;
        return $"{ex.GetType().FullName}: {msg} (HRESULT=0x{hresult:X8})";
    }

    public static int Main(string[] args)
    {
        try
        {
            var opts = Cli.Parse(args);

            var syncRoot = opts.Require("syncRoot");
            var pipeName = opts.Require("pipeName");
            var remoteFolderId = opts.Require("remoteFolderId");

            // Ensure single instance per pipe to avoid Cloud Files conflicts and enumeration timeouts.
            _singleInstanceMutex = new System.Threading.Mutex(initiallyOwned: true, name: $@"Global\BoltBytesVfsProvider_{pipeName}", createdNew: out var createdNew);
            if (!createdNew)
            {
                Console.WriteLine($"[Cloud Files] Another provider instance is already running for pipeName='{pipeName}'. Exiting.");
                return 0;
            }


            var providerId = Guid.TryParse(opts.Get("providerId"), out var guid)
                ? guid
                : Guid.Parse("4f6d0c5e-7c2f-4d9b-a7e0-75b9385c00b2");

            var providerName = opts.Get("providerName") ?? DefaultProviderName;

            var workspaceId = int.TryParse(opts.Get("workspaceId"), out var ws) ? ws : 0;

            Directory.CreateDirectory(syncRoot);

            _rpc = new PipeRpcClient(pipeName);
            _rpc.Connect(TimeSpan.FromSeconds(10));

            _provider = new ProviderRuntime(new ProviderOptions(
                syncRootPath: syncRoot,
                providerId: providerId,
                providerName: providerName,
                providerVersion: DefaultProviderVersion,
                remoteFolderId: remoteFolderId,
                workspaceId: workspaceId
            ), _rpc);

            _provider.Start();
            Console.WriteLine("Started.");

            var quit = new ManualResetEventSlim(false);
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                quit.Set();
            };

            quit.Wait();
            _provider.Stop();
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(FormatExceptionOneLine(ex));
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }
}

internal sealed record ProviderOptions(
    string syncRootPath,
    Guid providerId,
    string providerName,
    string providerVersion,
    string remoteFolderId,
    int workspaceId
);

internal sealed class ProviderRuntime
{
    private ProviderOptions _opts;
    private readonly PipeRpcClient _rpc;
    private readonly CfApi _cf = new();
    private CfApi.CF_CONNECTION_KEY _connectionKey;
    private bool _connected;
    private readonly CancellationTokenSource _cts = new();
    private Task? _pinMonitor;
    private readonly Dictionary<string, FileEntryMeta> _fileMetaByRelPath = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, bool> _pinnedByRelPath = new(StringComparer.OrdinalIgnoreCase);
    private readonly CfApi.CF_CALLBACK _onFetchDataCb;
    private readonly CfApi.CF_CALLBACK _onCancelFetchDataCb;
    private readonly CfApi.CF_CALLBACK _onFetchPlaceholdersCb;
    private readonly CfApi.CF_CALLBACK _onCancelFetchPlaceholdersCb;

    public ProviderRuntime(ProviderOptions opts, PipeRpcClient rpc)
    {
        _opts = opts;
        _rpc = rpc;
        _onFetchDataCb = OnFetchData;
        _onCancelFetchDataCb = OnCancelFetchData;
        _onFetchPlaceholdersCb = OnFetchPlaceholders;
        _onCancelFetchPlaceholdersCb = OnCancelFetchPlaceholders;
    }

    public void Start()
    {
        try { RegisterSyncRoot(); }
        catch (Exception ex) { throw new InvalidOperationException("Start() failed in RegisterSyncRoot()", ex); }

        try { Connect(); }
        catch (Exception ex) { throw new InvalidOperationException("Start() failed in Connect()", ex); }

        try { _rpc.Call<string>("ping", null); }
        catch (Exception ex) { throw new InvalidOperationException("Start() failed in RpcPing()", ex); }

        try { PopulatePlaceholders(); }
        catch (Exception ex) { throw new InvalidOperationException("Start() failed in PopulatePlaceholders()", ex); }

        StartPinMonitor();
    }

    public void Stop()
    {
        _cts.Cancel();
        try { _pinMonitor?.Wait(TimeSpan.FromSeconds(2)); } catch { }

        if (_connected)
        {
            _cf.DisconnectSyncRoot(_connectionKey);
            _connected = false;
        }

        // Intentionally do NOT unregister the sync root on exit.
    }

    private void RegisterSyncRoot()
{
    const int accessDeniedHr = unchecked((int)0x8007018B);
    const int maxAttempts = 5;

    for (var attempt = 0; attempt < maxAttempts; attempt++)
    {
        var identity = SHA1.HashData(Encoding.UTF8.GetBytes(_opts.providerId.ToString("D")));
        var fileIdentity = Array.Empty<byte>();

        unsafe
        {
            fixed (byte* idPtr = identity)
            fixed (byte* fidPtr = fileIdentity)
            {
                var registration = new CfApi.CF_SYNC_REGISTRATION
                {
                    StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_REGISTRATION>(),
                    ProviderName = _opts.providerName,
                    ProviderVersion = _opts.providerVersion,
                    SyncRootIdentity = (nint)idPtr,
                    SyncRootIdentityLength = (uint)identity.Length,
                    FileIdentity = (nint)fidPtr,
                    FileIdentityLength = 0,
                    ProviderId = _opts.providerId,
                };

                var policies = new CfApi.CF_SYNC_POLICIES
                {
                    StructSize = (uint)Marshal.SizeOf<CfApi.CF_SYNC_POLICIES>(),
                    Hydration = new CfApi.CF_HYDRATION_POLICY
                    {
                        Primary = (ushort)CfApi.CF_HYDRATION_POLICY_PRIMARY.CF_HYDRATION_POLICY_PARTIAL,
                        Modifier = (ushort)CfApi.CF_HYDRATION_POLICY_MODIFIER.CF_HYDRATION_POLICY_MODIFIER_STREAMING_ALLOWED,
                    },
                    Population = new CfApi.CF_POPULATION_POLICY
                    {
                        Primary = (ushort)CfApi.CF_POPULATION_POLICY_PRIMARY.CF_POPULATION_POLICY_FULL,
                    },
                    InSync = 0,
                    HardLink = 0,
                };

                // When iterating quickly in dev, unregister first to avoid stale registrations.
                try { _ = CfApi.CfUnregisterSyncRoot(_opts.syncRootPath); } catch { /* ignore */ }

                try
                {
                    _cf.RegisterSyncRoot(_opts.syncRootPath, in registration, in policies,
                        CfApi.CF_REGISTER_FLAGS.CF_REGISTER_FLAG_UPDATE |
                        CfApi.CF_REGISTER_FLAGS.CF_REGISTER_FLAG_MARK_IN_SYNC_ON_ROOT);
                    return;
                }
                catch (COMException ex) when (ex.HResult == accessDeniedHr && attempt < maxAttempts - 1)
                {
                    var oldPath = _opts.syncRootPath;
                    var devRoot = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "BoltBytesSyncDev");
                    var newPath = Path.Combine(
                        devRoot,
                        $"SyncRoot-{DateTime.UtcNow:yyyyMMdd-HHmmss-fff}-{attempt + 1}");

                    Directory.CreateDirectory(newPath);

                    // Rotate providerId too; Windows may remember previous registrations for a providerId.
                    _opts = _opts with { syncRootPath = newPath, providerId = Guid.NewGuid() };

                    Console.WriteLine($"[Cloud Files] RegisterSyncRoot denied for '{oldPath}'. Falling back to '{newPath}'.");
                }
            }
        }
    }
}

    private void Connect()
    {
        var callbacks = new[]
        {
            new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_FETCH_DATA, Callback = Marshal.GetFunctionPointerForDelegate(_onFetchDataCb) },
            new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_CANCEL_FETCH_DATA, Callback = Marshal.GetFunctionPointerForDelegate(_onCancelFetchDataCb) },
            new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS, Callback = Marshal.GetFunctionPointerForDelegate(_onFetchPlaceholdersCb) },
            new CfApi.CF_CALLBACK_REGISTRATION { Type = CfApi.CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_CANCEL_FETCH_PLACEHOLDERS, Callback = Marshal.GetFunctionPointerForDelegate(_onCancelFetchPlaceholdersCb) },
            CfApi.CF_CALLBACK_REGISTRATION_END,
        };

        unsafe
        {
            fixed (CfApi.CF_CALLBACK_REGISTRATION* cbPtr = callbacks)
            {
                _cf.ConnectSyncRoot(_opts.syncRootPath, cbPtr, nint.Zero, CfApi.CF_CONNECT_FLAGS.CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH, out _connectionKey);
                _connected = true;
            }
        }
    }

    private void PopulatePlaceholders()
    {
        var tree = _rpc.Call<TreeResult>("tree", new
        {
            parentId = _opts.remoteFolderId,
            workspaceId = _opts.workspaceId,
        });

        var folders = tree.folders ?? Array.Empty<RemoteFolder>();
        var files = tree.files ?? Array.Empty<RemoteFile>();

        Array.Sort(folders, (a, b) =>
        {
            var ra = NormalizeRelative(a.path ?? a.name ?? "");
            var rb = NormalizeRelative(b.path ?? b.name ?? "");
            var da = PathDepth(ra);
            var db = PathDepth(rb);
            var c = da.CompareTo(db);
            return c != 0 ? c : string.Compare(ra, rb, StringComparison.OrdinalIgnoreCase);
        });

        Array.Sort(files, (a, b) =>
        {
            var ra = NormalizeRelative(a.relativePath ?? a.name ?? "");
            var rb = NormalizeRelative(b.relativePath ?? b.name ?? "");
            var da = PathDepth(ra);
            var db = PathDepth(rb);
            var c = da.CompareTo(db);
            return c != 0 ? c : string.Compare(ra, rb, StringComparison.OrdinalIgnoreCase);
        });

        // Folders first.
        foreach (var folder in folders)
        {
            var rel = NormalizeRelative(folder.path ?? folder.name ?? "");
            if (string.IsNullOrWhiteSpace(rel)) continue;
            CreatePlaceholder(rel, isDirectory: true, fileSize: 0, updatedAtMs: folder.updatedAtMs ?? 0, identity: $"folder:{folder.id}");
        }

        // Files.
        _fileMetaByRelPath.Clear();
        foreach (var file in files)
        {
            var rel = NormalizeRelative(file.relativePath ?? file.name ?? "");
            if (string.IsNullOrWhiteSpace(rel)) continue;
            var size = file.fileSize ?? 0;
            CreatePlaceholder(rel, isDirectory: false, fileSize: size, updatedAtMs: file.updatedAtMs ?? 0, identity: $"file:{file.id}");
            _fileMetaByRelPath[rel] = new FileEntryMeta(file.id ?? "", file.name ?? rel, size);
        }

        Console.WriteLine($"Placeholders: {folders.Length} folders, {files.Length} files");
    }

    private static string NormalizeRelative(string input)
    {
        var v = input.Replace('/', '\\').TrimStart('\\').Trim();
        return v;
    }

    private static int PathDepth(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath)) return 0;
        var depth = 1;
        foreach (var c in relativePath)
        {
            if (c == '\\') depth++;
        }
        return depth;
    }

    private void CreatePlaceholder(string relativePath, bool isDirectory, long fileSize, long updatedAtMs, string identity)
    {
        if (string.IsNullOrWhiteSpace(relativePath))
        {
            return;
        }

        var fullPath = Path.Combine(_opts.syncRootPath, relativePath);

        // Idempotency: if a concrete item already exists, don't try to "supercede" it with a placeholder.
        if (isDirectory)
        {
            if (Directory.Exists(fullPath))
            {
                return;
            }
        }
        else
        {
            if (File.Exists(fullPath))
            {
                return;
            }
        }

        var identityBytes = Encoding.UTF8.GetBytes(identity ?? string.Empty);

        var basicInfo = new CfApi.FILE_BASIC_INFO
        {
            CreationTime = CfApi.ToFileTime(updatedAtMs),
            LastAccessTime = CfApi.ToFileTime(updatedAtMs),
            LastWriteTime = CfApi.ToFileTime(updatedAtMs),
            ChangeTime = CfApi.ToFileTime(updatedAtMs),
            FileAttributes = isDirectory
                ? (uint)CfApi.FileAttribute.FILE_ATTRIBUTE_DIRECTORY
                : (uint)CfApi.FileAttribute.FILE_ATTRIBUTE_NORMAL,
        };

        var meta = new CfApi.CF_FS_METADATA
        {
            BasicInfo = basicInfo,
            FileSize = isDirectory ? 0 : fileSize,
        };

        unsafe
        {
            fixed (byte* idPtr = identityBytes)
            {
                var info = new CfApi.CF_PLACEHOLDER_CREATE_INFO
                {
                    RelativeFileName = relativePath,
                    FsMetadata = meta,
                    FileIdentity = (nint)idPtr,
                    FileIdentityLength = (uint)identityBytes.Length,
                    Flags = CfApi.CF_PLACEHOLDER_CREATE_FLAGS.CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC,
                    Result = 0,
                    CreateUsn = 0,
                };

                try
                {
                    uint processed = 0;
                    _cf.CreatePlaceholders(_opts.syncRootPath, ref info, 1, CfApi.CF_CREATE_FLAGS.CF_CREATE_FLAG_NONE, out processed);
                }
                catch (COMException ex) when (ex.HResult == unchecked((int)0x800700B7) || ex.HResult == unchecked((int)0x8007017C))
                {
                    // ERROR_ALREADY_EXISTS or ERROR_CLOUD_OPERATION_INVALID: treat as idempotent "already done".
                }
            }
        }
    }

    private void StartPinMonitor()
    {
        _pinMonitor = Task.Run(async () =>
        {
            const int batchSize = 200;
            var relPaths = new List<string>();

            while (!_cts.IsCancellationRequested)
            {
                relPaths.Clear();
                relPaths.AddRange(_fileMetaByRelPath.Keys);

                for (var i = 0; i < relPaths.Count && !_cts.IsCancellationRequested; i += batchSize)
                {
                    var slice = relPaths.Skip(i).Take(batchSize);
                    foreach (var rel in slice)
                    {
                        var abs = Path.Combine(_opts.syncRootPath, rel);
                        if (!File.Exists(abs)) continue;

                        var attrs = CfApi.GetFileAttributes(abs);
                        var isPinned = (attrs & (uint)CfApi.FileAttribute.FILE_ATTRIBUTE_PINNED) != 0;
                        var isUnpinned = (attrs & (uint)CfApi.FileAttribute.FILE_ATTRIBUTE_UNPINNED) != 0;

                        // Ignore unspecified.
                        if (!isPinned && !isUnpinned) continue;

                        if (!_pinnedByRelPath.TryGetValue(rel, out var prevPinned))
                        {
                            _pinnedByRelPath[rel] = isPinned;
                            continue;
                        }

                        if (prevPinned != isPinned)
                        {
                            _pinnedByRelPath[rel] = isPinned;
                            try
                            {
                                if (isPinned)
                                {
                                    Hydrate(abs, rel);
                                }
                                else
                                {
                                    Dehydrate(abs, rel);
                                }
                            }
                            catch (Exception ex)
                            {
                                Console.Error.WriteLine($"Pin change failed for {rel}: {ex.Message}");
                            }
                        }
                    }
                }

                await Task.Delay(TimeSpan.FromSeconds(3), _cts.Token).ContinueWith(_ => { });
            }
        }, _cts.Token);
    }

    private void Hydrate(string fullPath, string relPath)
    {
        if (!_fileMetaByRelPath.TryGetValue(relPath, out var meta)) return;
        var handle = CfApi.CreateFileForCf(fullPath, writeAccess: true);
        try
        {
            _cf.HydratePlaceholder(handle, 0, meta.FileSize, CfApi.CF_HYDRATE_FLAGS.CF_HYDRATE_FLAG_NONE, nint.Zero);
        }
        finally
        {
            CfApi.CloseHandle(handle);
        }
    }

    private void Dehydrate(string fullPath, string relPath)
    {
        if (!_fileMetaByRelPath.TryGetValue(relPath, out var meta)) return;
        var handle = CfApi.CreateFileForCf(fullPath, writeAccess: true);
        try
        {
            _cf.DehydratePlaceholder(handle, 0, meta.FileSize, CfApi.CF_DEHYDRATE_FLAGS.CF_DEHYDRATE_FLAG_BACKGROUND, nint.Zero);
        }
        finally
        {
            CfApi.CloseHandle(handle);
        }
    }

    private void OnFetchData(nint callbackInfoPtr, nint callbackParametersPtr)
    {
        try
        {
            var callbackInfo = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(callbackInfoPtr);
            var callbackParams = Marshal.PtrToStructure<CfApi.CF_CALLBACK_PARAMETERS>(callbackParametersPtr);

            var identity = CfApi.ReadIdentity(callbackInfo.FileIdentity, callbackInfo.FileIdentityLength);
            if (!identity.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            {
                TransferError(callbackInfo.ConnectionKey, callbackInfo.TransferKey, callbackParams.FetchData.RequiredFileOffset, callbackParams.FetchData.RequiredLength);
                return;
            }

            var entryId = identity[5..];
            var offset = callbackParams.FetchData.RequiredFileOffset;
            var length = callbackParams.FetchData.RequiredLength;

            // CFAPI expects 4KB alignment for offset and (usually) length. We trust platform requests here. 
            var res = _rpc.Call<DownloadRangeResult>("downloadRange", new
            {
                entryId,
                offset,
                length,
            });

            var bytes = Convert.FromBase64String(res.dataBase64 ?? "");
            unsafe
            {
                fixed (byte* p = bytes)
                {
                    TransferData(callbackInfo.ConnectionKey, callbackInfo.TransferKey, (nint)p, offset, bytes.LongLength, 0);
                }
            }
        }
        catch
        {
            // Best-effort failure path.
        }
    }

    private void OnCancelFetchData(nint callbackInfoPtr, nint callbackParametersPtr)
    {
        // MVP: nothing to do.
    }

    

void OnFetchPlaceholders(nint callbackInfoPtr, nint callbackParametersPtr)
{
    // Never block this callback; Explorer/PowerShell will hang and eventually time out.
    try
    {
        // Kick off a best-effort initial population in the background (guarded).
        _ = System.Threading.Tasks.Task.Run(() =>
        {
            try { EnsureInitialPopulation(); } catch { /* ignore */ }
        });

        var info = Marshal.PtrToStructure<CfApi.CF_CALLBACK_INFO>(callbackInfoPtr);

        var opInfo = new CfApi.CF_OPERATION_INFO
        {
            StructSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_INFO>(),
            Type = CfApi.CF_OPERATION_TYPE.CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS,
            ConnectionKey = info.ConnectionKey,
            TransferKey = info.TransferKey,
            CorrelationVector = info.CorrelationVector,
            RequestKey = info.RequestKey,
        };

        var opParams = new CfApi.CF_OPERATION_PARAMETERS
        {
            ParamSize = CfApi.CF_OPERATION_PARAMETERS.SizeOfTransferPlaceholders(),
        };
        opParams.TransferPlaceholders.Flags =
            CfApi.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAGS.CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION;
        opParams.TransferPlaceholders.CompletionStatus = 0; // STATUS_SUCCESS
        opParams.TransferPlaceholders.PlaceholderTotalCount = new CfApi.CF_OPERATION_PARAMETERS.LARGE_INTEGER { QuadPart = 0 };
        opParams.TransferPlaceholders.PlaceholderArray = nint.Zero;
        opParams.TransferPlaceholders.PlaceholderCount = 0;
        opParams.TransferPlaceholders.EntriesProcessed = 0;

        _cf.Execute(in opInfo, ref opParams);
    }
    catch
    {
        // Swallow exceptions in unmanaged callback; crashing here breaks the shell.
    }
}

void OnCancelFetchPlaceholders(nint callbackInfoPtr, nint callbackParametersPtr)
    {
        // MVP: nothing to do.
    }

private int _didInitialPopulation;

private void EnsureInitialPopulation()
    {
        if (System.Threading.Interlocked.Exchange(ref _didInitialPopulation, 1) == 1) return;
        try
        {
            PopulatePlaceholders();
        }
        catch
        {
            // ignore; PopulatePlaceholders already logs
        }
    }

    private void TransferError(CfApi.CF_CONNECTION_KEY connectionKey, long transferKey, long offset, long length)
    {
        TransferData(connectionKey, transferKey, nint.Zero, offset, length, unchecked((int)0xC0000001)); // STATUS_UNSUCCESSFUL
    }

    private void TransferData(CfApi.CF_CONNECTION_KEY connectionKey, long transferKey, nint buffer, long offset, long length, int completionStatus)
    {
        var opInfo = new CfApi.CF_OPERATION_INFO
        {
            StructSize = (uint)Marshal.SizeOf<CfApi.CF_OPERATION_INFO>(),
            Type = CfApi.CF_OPERATION_TYPE.CF_OPERATION_TYPE_TRANSFER_DATA,
            ConnectionKey = connectionKey,
            TransferKey = transferKey,
            CorrelationVector = nint.Zero,
            SyncStatus = nint.Zero,
            RequestKey = 0,
        };

        var opParams = new CfApi.CF_OPERATION_PARAMETERS
        {
            ParamSize = CfApi.CF_OPERATION_PARAMETERS.SizeOfTransferData(),
            TransferData = new CfApi.CF_OPERATION_PARAMETERS.TRANSFER_DATA
            {
                Flags = CfApi.CF_OPERATION_TRANSFER_DATA_FLAGS.CF_OPERATION_TRANSFER_DATA_FLAG_NONE,
                CompletionStatus = completionStatus,
                Buffer = buffer,
                Offset = offset,
                Length = length,
            },
        };

        _cf.Execute(in opInfo, ref opParams);
    }
}

internal sealed record FileEntryMeta(string EntryId, string Name, long FileSize);

internal sealed class PipeRpcClient
{
    private readonly string _pipeName;
    private NamedPipeClientStream? _stream;
    private readonly object _lock = new();

    public PipeRpcClient(string pipeName)
    {
        _pipeName = pipeName;
    }

    public void Connect(TimeSpan timeout)
    {
        var stream = new NamedPipeClientStream(".", _pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        var ms = (int)Math.Clamp(timeout.TotalMilliseconds, 0, int.MaxValue);
        stream.Connect(ms);
        stream.ReadMode = PipeTransmissionMode.Byte;
        _stream = stream;
    }

    public T Call<T>(string method, object? @params)
    {
        return CallWithRetry<T>(method, @params, attempts: 2);
    }

    private T CallWithRetry<T>(string method, object? @params, int attempts)
    {
        if (attempts <= 0) throw new ArgumentOutOfRangeException(nameof(attempts));

        Exception? last = null;
        for (var attempt = 1; attempt <= attempts; attempt++)
        {
            try
            {
                EnsureConnected(TimeSpan.FromSeconds(10));

                var id = Guid.NewGuid().ToString("N");
                var req = Json.Serialize(new RpcRequest(id, method, @params));
                var reqBytes = Encoding.UTF8.GetBytes(req);
                var header = BitConverter.GetBytes(reqBytes.Length);

                lock (_lock)
                {
                    _stream!.Write(header, 0, header.Length);
                    _stream!.Write(reqBytes, 0, reqBytes.Length);
                    _stream!.Flush();

                    var respLen = ReadExactInt32(_stream!);
                    var respBytes = ReadExact(_stream!, respLen);
                    var respJson = Encoding.UTF8.GetString(respBytes);

                    var envelope = Json.Deserialize<RpcResponse>(respJson);
                    if (envelope is null || envelope.id != id) throw new IOException("Invalid RPC response.");
                    if (!envelope.ok) throw new IOException(envelope.error ?? "RPC error");

                    return Json.Deserialize<T>(envelope.resultJson ?? "{}")!;
                }
            }
            catch (EndOfStreamException ex)
            {
                last = ex;
                Reset();
            }
            catch (IOException ex)
            {
                last = ex;
                Reset();
            }
        }

        throw new IOException($"RPC '{method}' failed: pipe closed or server did not respond. Check that the app is running and pipeName matches.", last);
    }

    private void EnsureConnected(TimeSpan timeout)
    {
        if (_stream is not null && _stream.IsConnected) return;
        Connect(timeout);
    }

    private void Reset()
    {
        try { _stream?.Dispose(); } catch { }
        _stream = null;
    }

    private static int ReadExactInt32(Stream s)
    {
        var buf = ReadExact(s, 4);
        return BitConverter.ToInt32(buf, 0);
    }

    private static byte[] ReadExact(Stream s, int len)
    {
        var buf = new byte[len];
        var read = 0;
        while (read < len)
        {
            var n = s.Read(buf, read, len - read);
            if (n <= 0) throw new EndOfStreamException();
            read += n;
        }
        return buf;
    }

    private sealed record RpcRequest(string id, string method, object? @params);

    private sealed record RpcResponse(string id, bool ok, string? error, object? result)
    {
        public string resultJson => result is null ? "{}" : Json.Serialize(result);
    }
}

internal static class Json
{
    public static string Serialize<T>(T value) => System.Text.Json.JsonSerializer.Serialize(value, new System.Text.Json.JsonSerializerOptions
    {
        PropertyNamingPolicy = System.Text.Json.JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    });

    public static T? Deserialize<T>(string json) => System.Text.Json.JsonSerializer.Deserialize<T>(json, new System.Text.Json.JsonSerializerOptions
    {
        PropertyNameCaseInsensitive = true,
    });
}

internal sealed record TreeResult(RemoteFolder[]? folders, RemoteFile[]? files);

internal sealed record RemoteFolder(string? id, string? name, string? path, long? updatedAtMs);

internal sealed record RemoteFile(string? id, string? name, string? relativePath, long? fileSize, long? updatedAtMs);

internal sealed record DownloadRangeResult(string? dataBase64, int? length);

internal static class Cli
{
    public static Dictionary<string, string?> Parse(string[] args)
    {
        var result = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--") continue;
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
            var key = args[i][2..];
            var value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal) ? args[i + 1] : null;
            if (value is not null) i += 1;
            result[key] = value;
        }
        return result;
    }

    public static string Require(this Dictionary<string, string?> opts, string key)
        => opts.Get(key) ?? throw new ArgumentException($"Missing --{key}");

    public static string? Get(this Dictionary<string, string?> opts, string key)
        => opts.TryGetValue(key, out var value) ? value : null;
}

internal sealed class CfApi
{
    private const string Dll = "cldapi.dll";

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate void CF_CALLBACK(nint callbackInfo, nint callbackParameters);

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_CALLBACK_REGISTRATION
    {
        public CF_CALLBACK_TYPE Type;
        public nint Callback;
    }

    public static readonly CF_CALLBACK_REGISTRATION CF_CALLBACK_REGISTRATION_END = new()
    {
        Type = CF_CALLBACK_TYPE.CF_CALLBACK_TYPE_NONE,
        Callback = 0,
    };

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_SYNC_REGISTRATION
    {
        public uint StructSize;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderName;
        [MarshalAs(UnmanagedType.LPWStr)] public string ProviderVersion;
        public nint SyncRootIdentity;
        public uint SyncRootIdentityLength;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public Guid ProviderId;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_SYNC_POLICIES
    {
        public uint StructSize;
        public CF_HYDRATION_POLICY Hydration;
        public CF_POPULATION_POLICY Population;
        public uint InSync;
        public uint HardLink;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_HYDRATION_POLICY
    {
        public ushort Primary;
        public ushort Modifier;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_POPULATION_POLICY
    {
        public ushort Primary;
        public ushort Modifier;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_CONNECTION_KEY
    {
        public long Internal;
    }

    public enum CF_HYDRATION_POLICY_PRIMARY : ushort
    {
        CF_HYDRATION_POLICY_PARTIAL = 0,
        CF_HYDRATION_POLICY_PROGRESSIVE = 1,
        CF_HYDRATION_POLICY_FULL = 2,
        CF_HYDRATION_POLICY_ALWAYS_FULL = 3,
    }

    [Flags]
    public enum CF_HYDRATION_POLICY_MODIFIER : ushort
    {
        CF_HYDRATION_POLICY_MODIFIER_NONE = 0x0000,
        CF_HYDRATION_POLICY_MODIFIER_VALIDATION_REQUIRED = 0x0001,
        CF_HYDRATION_POLICY_MODIFIER_STREAMING_ALLOWED = 0x0002,
        CF_HYDRATION_POLICY_MODIFIER_AUTO_DEHYDRATION_ALLOWED = 0x0004,
    }

    public enum CF_POPULATION_POLICY_PRIMARY : ushort
    {
        CF_POPULATION_POLICY_PARTIAL = 0,
        CF_POPULATION_POLICY_FULL = 2,
        CF_POPULATION_POLICY_ALWAYS_FULL = 3,
    }

    [Flags]
    public enum CF_INSYNC_POLICY : uint
    {
        CF_INSYNC_POLICY_NONE = 0x00000000,
        CF_INSYNC_POLICY_TRACK_ALL = 0x00ffffff,
    }

    [Flags]
    public enum CF_HARDLINK_POLICY : uint
    {
        CF_HARDLINK_POLICY_NONE = 0x00000000,
        CF_HARDLINK_POLICY_ALLOWED = 0x00000001,
    }

    [Flags]
    public enum CF_REGISTER_FLAGS : uint
    {
        CF_REGISTER_FLAG_NONE = 0x00000000,
        CF_REGISTER_FLAG_UPDATE = 0x00000001,
        CF_REGISTER_FLAG_DISABLE_ON_DEMAND_POPULATION_ON_ROOT = 0x00000002,
        CF_REGISTER_FLAG_MARK_IN_SYNC_ON_ROOT = 0x00000004,
    }

    [Flags]
    public enum CF_CONNECT_FLAGS : uint
    {
        CF_CONNECT_FLAG_NONE = 0x00000000,
        CF_CONNECT_FLAG_REQUIRE_PROCESS_INFO = 0x00000002,
        CF_CONNECT_FLAG_REQUIRE_FULL_FILE_PATH = 0x00000004,
        CF_CONNECT_FLAG_BLOCK_SELF_IMPLICIT_HYDRATION = 0x00000008,
    }

    public enum CF_CALLBACK_TYPE : uint
    {
        CF_CALLBACK_TYPE_FETCH_DATA = 0,
        CF_CALLBACK_TYPE_CANCEL_FETCH_DATA = 1,
        CF_CALLBACK_TYPE_FETCH_PLACEHOLDERS = 2,
        CF_CALLBACK_TYPE_CANCEL_FETCH_PLACEHOLDERS = 3,
        // many omitted
        CF_CALLBACK_TYPE_NONE = 0xffffffff,
    }

    [Flags]
    public enum CF_CALLBACK_FETCH_DATA_FLAGS : uint
    {
        CF_CALLBACK_FETCH_DATA_FLAG_NONE = 0x00000000,
        CF_CALLBACK_FETCH_DATA_FLAG_RECOVERY = 0x00000001,
        CF_CALLBACK_FETCH_DATA_FLAG_EXPLICIT_HYDRATION = 0x00000002,
    }

    [Flags]
    public enum CF_CALLBACK_CANCEL_FLAGS : uint
    {
        CF_CALLBACK_CANCEL_FLAG_NONE = 0x00000000,
        CF_CALLBACK_CANCEL_FLAG_IO_TIMEOUT = 0x00000001,
        CF_CALLBACK_CANCEL_FLAG_IO_ABORTED = 0x00000002,
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_CALLBACK_INFO
    {
        public uint StructSize;
        public CF_CONNECTION_KEY ConnectionKey;
        public nint CallbackContext;
        public nint VolumeGuidName;
        public nint VolumeDosName;
        public uint VolumeSerialNumber;
        public long SyncRootFileId;
        public nint SyncRootIdentity;
        public uint SyncRootIdentityLength;
        public long FileId;
        public long FileSize;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public nint NormalizedPath;
        public long TransferKey;
        public byte PriorityHint;
        private readonly byte _pad1;
        private readonly ushort _pad2;
        public nint CorrelationVector;
        public nint ProcessInfo;
        public long RequestKey;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct CF_CALLBACK_PARAMETERS
    {
        [FieldOffset(0)] public uint ParamSize;
        [FieldOffset(8)] public FETCH_DATA FetchData;
        [FieldOffset(8)] public CANCEL Cancel;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FETCH_DATA
    {
        public CF_CALLBACK_FETCH_DATA_FLAGS Flags;
        public uint _pad;
        public long RequiredFileOffset;
        public long RequiredLength;
        public long OptionalFileOffset;
        public long OptionalLength;
        public long LastDehydrationTime;
        public int LastDehydrationReason;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CANCEL
    {
        public CF_CALLBACK_CANCEL_FLAGS Flags;
        public uint _pad;
        public long FileOffset;
        public long Length;
    }

    public enum CF_OPERATION_TYPE : uint
    {
        CF_OPERATION_TYPE_TRANSFER_DATA = 0,
        CF_OPERATION_TYPE_RETRIEVE_DATA = 1,
        CF_OPERATION_TYPE_ACK_DATA = 2,
        CF_OPERATION_TYPE_RESTART_HYDRATION = 3,
        CF_OPERATION_TYPE_TRANSFER_PLACEHOLDERS = 4,
    }

    [Flags]
    public enum CF_OPERATION_TRANSFER_DATA_FLAGS : uint
    {
        CF_OPERATION_TRANSFER_DATA_FLAG_NONE = 0x00000000,
    }

    

    [Flags]
    public enum CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAGS : uint
    {
        CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_NONE = 0x00000000,
        CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_STOP_ON_ERROR = 0x00000001,
        CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAG_DISABLE_ON_DEMAND_POPULATION = 0x00000002,
    }
[StructLayout(LayoutKind.Sequential)]
    public struct CF_OPERATION_INFO
    {
        public uint StructSize;
        public CF_OPERATION_TYPE Type;
        public CF_CONNECTION_KEY ConnectionKey;
        public long TransferKey;
        public nint CorrelationVector;
        public nint SyncStatus;
        public long RequestKey;
    }

    
[StructLayout(LayoutKind.Explicit)]
public struct CF_OPERATION_PARAMETERS
{
    [FieldOffset(0)] public uint ParamSize;
    [FieldOffset(4)] public uint _pad;

    [FieldOffset(8)] public TRANSFER_DATA TransferData;
    [FieldOffset(8)] public TRANSFER_PLACEHOLDERS TransferPlaceholders;

    public static uint SizeOfTransferData()
    {
        return (uint)(Marshal.SizeOf<TRANSFER_DATA>() + sizeof(uint));
    }

    public static uint SizeOfTransferPlaceholders()
    {
        return (uint)(Marshal.SizeOf<TRANSFER_PLACEHOLDERS>() + sizeof(uint));
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TRANSFER_DATA
    {
        public CF_OPERATION_TRANSFER_DATA_FLAGS Flags;
        public int CompletionStatus;
        public nint Buffer;
        public long Offset;
        public long Length;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LARGE_INTEGER
    {
        public long QuadPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct TRANSFER_PLACEHOLDERS
    {
        public CF_OPERATION_TRANSFER_PLACEHOLDERS_FLAGS Flags;
        public int CompletionStatus;
        public LARGE_INTEGER PlaceholderTotalCount;
        public nint PlaceholderArray;
        public uint PlaceholderCount;
        public uint EntriesProcessed;
    }
}

[StructLayout(LayoutKind.Sequential)]
    public struct FILE_BASIC_INFO
    {
        public long CreationTime;
        public long LastAccessTime;
        public long LastWriteTime;
        public long ChangeTime;
        public uint FileAttributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CF_FS_METADATA
    {
        public FILE_BASIC_INFO BasicInfo;
        public long FileSize;
    }

    [Flags]
    public enum CF_PLACEHOLDER_CREATE_FLAGS : uint
    {
        CF_PLACEHOLDER_CREATE_FLAG_NONE = 0x00000000,
        CF_PLACEHOLDER_CREATE_FLAG_DISABLE_ON_DEMAND_POPULATION = 0x00000001,
        CF_PLACEHOLDER_CREATE_FLAG_MARK_IN_SYNC = 0x00000002,
        CF_PLACEHOLDER_CREATE_FLAG_SUPERSEDE = 0x00000004,
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CF_PLACEHOLDER_CREATE_INFO
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string RelativeFileName;
        public CF_FS_METADATA FsMetadata;
        public nint FileIdentity;
        public uint FileIdentityLength;
        public CF_PLACEHOLDER_CREATE_FLAGS Flags;
        public int Result;
        public long CreateUsn;
    }

    [Flags]
    public enum CF_CREATE_FLAGS : uint
    {
        CF_CREATE_FLAG_NONE = 0x00000000,
        CF_CREATE_FLAG_STOP_ON_ERROR = 0x00000001,
    }

    [Flags]
    public enum CF_HYDRATE_FLAGS : uint
    {
        CF_HYDRATE_FLAG_NONE = 0x00000000,
    }

    [Flags]
    public enum CF_DEHYDRATE_FLAGS : uint
    {
        CF_DEHYDRATE_FLAG_NONE = 0x00000000,
        CF_DEHYDRATE_FLAG_BACKGROUND = 0x00000001,
    }

    [Flags]
    public enum FileAttribute : uint
    {
        FILE_ATTRIBUTE_READONLY = 0x00000001,
        FILE_ATTRIBUTE_HIDDEN = 0x00000002,
        FILE_ATTRIBUTE_SYSTEM = 0x00000004,
        FILE_ATTRIBUTE_DIRECTORY = 0x00000010,
        FILE_ATTRIBUTE_NORMAL = 0x00000080,

        // Values documented for HSM / Files-on-demand. 
        FILE_ATTRIBUTE_PINNED = 0x00080000,
        FILE_ATTRIBUTE_UNPINNED = 0x00100000,
    }

    [DllImport(Dll, CharSet = CharSet.Unicode)]
    public static extern int CfRegisterSyncRoot(
        string syncRootPath,
        in CF_SYNC_REGISTRATION registration,
        in CF_SYNC_POLICIES policies,
        CF_REGISTER_FLAGS registerFlags);

    [DllImport(Dll, CharSet = CharSet.Unicode)]
    public static extern int CfUnregisterSyncRoot(string syncRootPath);

    [DllImport(Dll, CharSet = CharSet.Unicode)]
    public static extern unsafe int CfConnectSyncRoot(
        string syncRootPath,
        CF_CALLBACK_REGISTRATION* callbackTable,
        nint callbackContext,
        CF_CONNECT_FLAGS connectFlags,
        out CF_CONNECTION_KEY connectionKey);

    [DllImport(Dll)]
    public static extern int CfDisconnectSyncRoot(CF_CONNECTION_KEY connectionKey);

    [DllImport(Dll, CharSet = CharSet.Unicode)]
    public static extern int CfCreatePlaceholders(
        string baseDirectoryPath,
        ref CF_PLACEHOLDER_CREATE_INFO placeholderArray,
        uint placeholderCount,
        CF_CREATE_FLAGS createFlags,
        out uint entriesProcessed);

    [DllImport(Dll)]
    public static extern int CfExecute(in CF_OPERATION_INFO opInfo, ref CF_OPERATION_PARAMETERS opParams);

    [DllImport(Dll)]
    public static extern int CfHydratePlaceholder(nint fileHandle, long startingOffset, long length, CF_HYDRATE_FLAGS hydrateFlags, nint overlapped);

    [DllImport(Dll)]
    public static extern int CfDehydratePlaceholder(nint fileHandle, long startingOffset, long length, CF_DEHYDRATE_FLAGS dehydrateFlags, nint overlapped);

    public void RegisterSyncRoot(string syncRootPath, in CF_SYNC_REGISTRATION registration, in CF_SYNC_POLICIES policies, CF_REGISTER_FLAGS flags)
        => ThrowIfFailed(CfRegisterSyncRoot(syncRootPath, registration, policies, flags), "CfRegisterSyncRoot");

    public unsafe void ConnectSyncRoot(string syncRootPath, CF_CALLBACK_REGISTRATION* cb, nint ctx, CF_CONNECT_FLAGS flags, out CF_CONNECTION_KEY key)
        => ThrowIfFailed(CfConnectSyncRoot(syncRootPath, cb, ctx, flags, out key), "CfConnectSyncRoot");

    public void DisconnectSyncRoot(CF_CONNECTION_KEY key)
        => ThrowIfFailed(CfDisconnectSyncRoot(key), "CfDisconnectSyncRoot");

    public void CreatePlaceholders(string baseDir, ref CF_PLACEHOLDER_CREATE_INFO placeholder, uint count, CF_CREATE_FLAGS flags, out uint processed)
        => ThrowIfFailed(CfCreatePlaceholders(baseDir, ref placeholder, count, flags, out processed), "CfCreatePlaceholders");

    public void Execute(in CF_OPERATION_INFO opInfo, ref CF_OPERATION_PARAMETERS opParams)
        => ThrowIfFailed(CfExecute(opInfo, ref opParams), "CfExecute");

    public void HydratePlaceholder(nint handle, long offset, long length, CF_HYDRATE_FLAGS flags, nint overlapped)
        => ThrowIfFailed(CfHydratePlaceholder(handle, offset, length, flags, overlapped), "CfHydratePlaceholder");

    public void DehydratePlaceholder(nint handle, long offset, long length, CF_DEHYDRATE_FLAGS flags, nint overlapped)
        => ThrowIfFailed(CfDehydratePlaceholder(handle, offset, length, flags, overlapped), "CfDehydratePlaceholder");

    public static long ToFileTime(long unixMs)
    {
        if (unixMs <= 0) return DateTime.UtcNow.ToFileTimeUtc();
        var dt = DateTimeOffset.FromUnixTimeMilliseconds(unixMs).UtcDateTime;
        return dt.ToFileTimeUtc();
    }

    public static string ReadIdentity(nint identityPtr, uint identityLen)
    {
        if (identityPtr == nint.Zero || identityLen == 0) return string.Empty;
        var bytes = new byte[identityLen];
        Marshal.Copy(identityPtr, bytes, 0, bytes.Length);
        return Encoding.UTF8.GetString(bytes);
    }

    public static uint GetFileAttributes(string path)
    {
        var attrs = GetFileAttributesW(path);
        if (attrs == 0xFFFFFFFF) return 0;
        return attrs;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string lpFileName);

    public static nint CreateFileForCf(string path, bool writeAccess)
    {
        var access = writeAccess ? (uint)(FileAccessMask.GENERIC_READ | FileAccessMask.GENERIC_WRITE) : (uint)FileAccessMask.GENERIC_READ;
        return CreateFileW(path, access, (uint)(FileShareMask.Read | FileShareMask.Write | FileShareMask.Delete), nint.Zero, (uint)CreationDisposition.OpenExisting, (uint)(FileFlagsAndAttributes.BackupSemantics | FileFlagsAndAttributes.Overlapped), nint.Zero);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern nint CreateFileW(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        nint lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        nint hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(nint hObject);

    [Flags]
    private enum FileAccessMask : uint
    {
        GENERIC_READ = 0x80000000,
        GENERIC_WRITE = 0x40000000,
    }

    [Flags]
    private enum FileShareMask : uint
    {
        Read = 0x00000001,
        Write = 0x00000002,
        Delete = 0x00000004,
    }

    private enum CreationDisposition : uint
    {
        OpenExisting = 3,
    }

    [Flags]
    private enum FileFlagsAndAttributes : uint
    {
        Overlapped = 0x40000000,
        BackupSemantics = 0x02000000,
    }

    private static void ThrowIfFailed(int hr, string name)
    {
        // CloudFiles returns HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS) when a placeholder already exists.
        // Treat as success to allow idempotent placeholder population.
        const int HResultAlreadyExists = unchecked((int)0x800700B7);

        if (hr >= 0) return;

        if (hr == HResultAlreadyExists &&
            string.Equals(name, "CfCreatePlaceholders", StringComparison.Ordinal))
        {
            return;
        }

        Marshal.ThrowExceptionForHR(hr);
        throw new InvalidOperationException($"{name} failed: 0x{hr:X8}");
    }
}
