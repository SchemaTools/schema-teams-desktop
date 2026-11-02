// Read-only Authenticode verifier. Never loads the inspected PE as executable code.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

internal static class PluginSignature
{
    const long MaxFile = 200L * 1024 * 1024;
    const long MaxDesktopFile = 512L * 1024 * 1024;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct FileInfo { public uint size; [MarshalAs(UnmanagedType.LPWStr)] public string path; public IntPtr file, subject; }
    [StructLayout(LayoutKind.Sequential)]
    struct TrustData {
        public uint size; public IntPtr policy, sip; public uint ui, revoke, choice;
        public IntPtr info; public uint action; public IntPtr state, url;
        public uint flags, context; public IntPtr signatures;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Signer {
        public uint size, timeLow, timeHigh, certCount; public IntPtr certs;
        public uint type; public IntPtr signer; public uint error, counterCount;
        public IntPtr counters, chain;
    }
    // Prefixes only: memory is owned by the verified provider state, not this process.
    [StructLayout(LayoutKind.Sequential)]
    struct ProviderCert { public uint size; public IntPtr cert; }
    [StructLayout(LayoutKind.Sequential)]
    struct CertContext { public uint encoding; public IntPtr encoded; public uint length; }
    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref TrustData data);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern IntPtr WTHelperProvDataFromStateData(IntPtr state);
    [DllImport("wintrust.dll", ExactSpelling = true)]
    static extern IntPtr WTHelperGetProvSignerFromChain(IntPtr provider, uint signer, [MarshalAs(UnmanagedType.Bool)] bool counter, uint counterIndex);

    static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    static T Read<T>(IntPtr ptr) { return (T)Marshal.PtrToStructure(ptr, typeof(T)); }
    static void Range(long offset, long size, long length) {
        if (offset < 0 || size < 0 || offset > length || size > length - offset) throw new InvalidDataException();
    }
    static uint U32(BinaryReader r, long at) { Range(at, 4, r.BaseStream.Length); r.BaseStream.Position = at; return r.ReadUInt32(); }
    static ushort U16(BinaryReader r, long at) { Range(at, 2, r.BaseStream.Length); r.BaseStream.Position = at; return r.ReadUInt16(); }

    // Strict bounded PE subset: ordinary PE32/PE32+, <=96 sections, at most 16 cert entries.
    // Certificate table uses file offsets, must be outside headers/sections and contain PKCS#7.
    static bool HasEmbeddedSignature(FileStream stream) {
        BinaryReader r = new BinaryReader(stream);
        long length = stream.Length;
        if (U16(r, 0) != 0x5a4d) throw new InvalidDataException();
        long pe = U32(r, 0x3c); Range(pe, 24, length);
        if (pe < 64 || U32(r, pe) != 0x4550) throw new InvalidDataException();
        int count = U16(r, pe + 6), optionalSize = U16(r, pe + 20);
        if (count < 1 || count > 96) throw new InvalidDataException();
        long optional = pe + 24; Range(optional, optionalSize, length);
        int magic = U16(r, optional);
        int directories = magic == 0x10b ? 96 : magic == 0x20b ? 112 : -1;
        if (directories < 0 || optionalSize < directories || optionalSize < 68) throw new InvalidDataException();
        long sectionTable = optional + optionalSize; Range(sectionTable, count * 40, length);
        long headers = U32(r, optional + 60);
        if (headers < sectionTable + count * 40 || headers > length) throw new InvalidDataException();
        long end = headers;
        long[] starts = new long[count], ends = new long[count];
        for (int i = 0; i < count; i++) {
            long section = sectionTable + i * 40;
            long size = U32(r, section + 16), start = U32(r, section + 20);
            if (size == 0) continue;
            Range(start, size, length);
            if (start < headers) throw new InvalidDataException();
            for (int j = 0; j < i; j++) if (start < ends[j] && starts[j] < start + size) throw new InvalidDataException();
            starts[i] = start; ends[i] = start + size; end = Math.Max(end, start + size);
        }
        uint directoryCount = U32(r, optional + directories - 4);
        if (directoryCount > 16 || optionalSize < directories + directoryCount * 8) throw new InvalidDataException();
        if (directoryCount <= 4) return false;
        long cert = U32(r, optional + directories + 32), certSize = U32(r, optional + directories + 36);
        if (cert == 0 && certSize == 0) return false;
        Range(cert, certSize, length);
        if (cert < end || certSize < 8 || (cert & 7) != 0 || (certSize & 7) != 0) throw new InvalidDataException();
        long position = cert; int entries = 0; bool pkcs7 = false;
        while (position < cert + certSize) {
            if (++entries > 16) throw new InvalidDataException();
            Range(position, 8, cert + certSize);
            long size = U32(r, position);
            if (size < 8) throw new InvalidDataException();
            Range(position, size, cert + certSize);
            if (U16(r, position + 4) != 0x200 || U16(r, position + 6) != 2) throw new InvalidDataException();
            pkcs7 = true;
            position += (size + 7) & ~7L;
        }
        if (position != cert + certSize) throw new InvalidDataException();
        return pkcs7;
    }

    static string Verify(FileStream stream, string path, out string pin, out string code) {
        pin = null; code = null;
        FileInfo info = new FileInfo { size = (uint)Marshal.SizeOf(typeof(FileInfo)), path = path, file = stream.SafeFileHandle.DangerousGetHandle() };
        IntPtr nativeInfo = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(FileInfo)));
        TrustData data = new TrustData { size = (uint)Marshal.SizeOf(typeof(TrustData)), ui = 2,
            revoke = 1, choice = 1, info = nativeInfo, action = 1, context = 1,
            // Whole-chain revocation excluding trust anchor, cached evidence only; no network.
            // Standard Windows Authenticode timestamp policy: a verified timestamp may
            // preserve a signature beyond signer expiry (no LIFETIME_SIGNING_FLAG).
            // Never NO_POLICY_USAGE, HASH_ONLY, or REVOCATION_CHECK_NONE.
            flags = 0x80 | 0x1000 | 0x2000 };
        Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
        Marshal.StructureToPtr(info, nativeInfo, false);
        try {
            int result = WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            code = unchecked((uint)result).ToString("x8");
            if (result != 0) {
                uint status = unchecked((uint)result);
                // Only positively identified failures are invalid; all unrecognized/provider/offline failures unknown.
                if (status == 0x80096010 || status == 0x800B0100 || status == 0x800B0101 || status == 0x800B0109 || status == 0x800B010C || status == 0x800B0111 || status == 0x800B0004) return "invalid";
                return "unknown";
            }
            IntPtr provider = WTHelperProvDataFromStateData(data.state);
            if (provider == IntPtr.Zero) return "unknown";
            IntPtr signerPtr = WTHelperGetProvSignerFromChain(provider, 0, false, 0);
            if (signerPtr == IntPtr.Zero) return "unknown";
            Signer signer = Read<Signer>(signerPtr);
            if (signer.error != 0 || signer.certCount < 1 || signer.certCount > 32 || signer.certs == IntPtr.Zero || signer.chain == IntPtr.Zero) return "unknown";
            ProviderCert cert = Read<ProviderCert>(signer.certs);
            if (cert.cert == IntPtr.Zero) return "unknown";
            CertContext context = Read<CertContext>(cert.cert);
            if (context.encoded == IntPtr.Zero || context.length == 0 || context.length > 65536) return "unknown";
            byte[] der = new byte[context.length]; Marshal.Copy(context.encoded, der, 0, der.Length);
            using (SHA256 sha = SHA256.Create()) pin = Hex(sha.ComputeHash(der));
            return "valid";
        }
        finally {
            // Every VERIFY gets CLOSE; signer bytes were copied while this exact state was live.
            data.action = 2;
            try { WinVerifyTrust(new IntPtr(-1), ref action, ref data); }
            finally { Marshal.DestroyStructure(nativeInfo, typeof(FileInfo)); Marshal.FreeHGlobal(nativeInfo); }
        }
    }
    static string Quoted(string value) { return value == null ? "null" : "\"" + value + "\""; }
    static void Output(string verdict, string reason, string hash, string pin, string code) {
        Console.WriteLine("{\"v\":1,\"verdict\":\"" + verdict + "\",\"reason\":\"" + reason + "\",\"fileSha256\":" + Quoted(hash) + ",\"signerDerSha256\":" + Quoted(pin) + ",\"winTrustCode\":" + Quoted(code) + "}");
    }
    static int Main(string[] args) {
        string hash = null;
        try {
            bool desktop = args.Length == 3 && args[2] == "desktop";
            if (args.Length != (desktop ? 3 : 2) || !Regex.IsMatch(args[1], "\\A[0-9a-f]{64}\\z") || !Path.IsPathRooted(args[0]) || args[0].Length > 32760) {
                Output("invalid", "input", null, null, null); return 0;
            }
            if ((File.GetAttributes(args[0]) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) {
                Output("invalid", "file-type", null, null, null); return 0;
            }
            // Deny write/delete sharing until both hash and provider-state extraction finish.
            using (FileStream file = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.SequentialScan)) {
                if (file.Length < 64 || file.Length > (desktop ? MaxDesktopFile : MaxFile)) { Output("invalid", "size", null, null, null); return 0; }
                using (SHA256 sha = SHA256.Create()) hash = Hex(sha.ComputeHash(file));
                if (hash != args[1]) { Output("invalid", "hash-mismatch", hash, null, null); return 0; }
                bool embedded;
                try { embedded = HasEmbeddedSignature(file); }
                catch (InvalidDataException) { Output("invalid", "malformed-pe", hash, null, null); return 0; }
                if (!embedded) { Output("invalid", "no-embedded-signature", hash, null, null); return 0; }
                file.Position = 0;
                string pin, code; string verdict = Verify(file, args[0], out pin, out code);
                file.Position = 0;
                using (SHA256 sha = SHA256.Create()) {
                    if (Hex(sha.ComputeHash(file)) != hash) { Output("unknown", "file-changed", hash, null, code); return 0; }
                }
                Output(verdict, verdict == "valid" ? "verified" : "wintrust", hash, pin, code);
            }
        }
        catch (Exception) { Output("unknown", "unavailable", hash, null, null); }
        return 0;
    }
}
