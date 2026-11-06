using System;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using Microsoft.Win32;
// Только чтение (решение 06.11): ключ удаления прежней установки плагинов (Inno) и наличие
// сертификата бюро в хранилищах пользователя. Ничего не запускает, не пишет и не удаляет.
// Вывод — одна строка JSON в ASCII (не-ASCII — \uXXXX): кодовая страница консоли не важна.
internal static class PluginSetup {
  const string InnoKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\{151FB371-4F8E-49BE-8DDE-E90DCD5C3809}_is1";
  static string Json(string value) {
    var sb = new StringBuilder("\"");
    foreach (var c in value) {
      if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
      else if (c < 0x20 || c > 0x7e) { sb.Append("\\u").Append(((int)c).ToString("x4")); }
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
  static bool InStore(StoreName name, string sha256) {
    var store = new X509Store(name, StoreLocation.CurrentUser);
    store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
    try {
      using (var hash = SHA256.Create()) {
        foreach (var cert in store.Certificates) {
          var bytes = hash.ComputeHash(cert.RawData);
          var hex = BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
          if (hex == sha256) return true;
        }
      }
    } finally { store.Close(); }
    return false;
  }
  static int Main(string[] args) {
    try {
      if (args.Length == 1 && args[0] == "inno") {
        using (var key = Registry.CurrentUser.OpenSubKey(InnoKey, false)) {
          if (key == null) { Console.WriteLine("{\"v\":1,\"found\":false}"); return 0; }
          var value = key.GetValue("UninstallString", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
          if (value == null || value.Length > 4096) { Console.WriteLine("{\"v\":1,\"found\":true,\"uninstallString\":null}"); return 0; }
          Console.WriteLine("{\"v\":1,\"found\":true,\"uninstallString\":" + Json(value) + "}");
          return 0;
        }
      }
      if (args.Length == 2 && args[0] == "cert" && args[1].Length == 64) {
        foreach (var c in args[1]) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) throw new ArgumentException();
        bool root = false, publisher = false;
        try { root = InStore(StoreName.Root, args[1]); } catch (CryptographicException) { }
        try { publisher = InStore(StoreName.TrustedPublisher, args[1]); } catch (CryptographicException) { }
        Console.WriteLine("{\"v\":1,\"root\":" + (root ? "true" : "false") + ",\"trustedPublisher\":" + (publisher ? "true" : "false") + "}");
        return 0;
      }
    } catch { }
    Console.WriteLine("{\"v\":1,\"error\":true}");
    return 0;
  }
}
