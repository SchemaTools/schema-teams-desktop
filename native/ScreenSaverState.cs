// Read-only WinSta0 observation. No settings, registry, desktop switches or saver launch.
using System;
using System.Runtime.InteropServices;
using System.Text;

internal static class ScreenSaverState
{
    [DllImport("user32.dll", ExactSpelling = true)]
    private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformationW(
        IntPtr handle, int index, StringBuilder text, uint bytes, out uint needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SystemParametersInfoW(uint action, uint param, out int value, uint flags);

    private static string Read()
    {
        try
        {
            // Borrowed handle; never CloseWindowStation.
            IntPtr station = GetProcessWindowStation();
            if (station == IntPtr.Zero) return "unknown";
            StringBuilder name = new StringBuilder(256);
            uint needed;
            if (!GetUserObjectInformationW(station, 2, name, 512, out needed) ||
                needed == 0 || needed > 512 ||
                !String.Equals(name.ToString(), "WinSta0", StringComparison.OrdinalIgnoreCase))
                return "unknown";
            int running;
            if (!SystemParametersInfoW(0x0072, 0, out running, 0)) return "unknown";
            return running == 1 ? "running" : running == 0 ? "stopped" : "unknown";
        }
        catch (Exception) { return "unknown"; }
    }
    private static int Main(string[] args)
    {
        Console.WriteLine("{\"v\":1,\"state\":\"" + (args.Length == 0 ? Read() : "unknown") + "\"}");
        return 0;
    }
}
