// Собственный helper для документированного Win32 API; состояния и текст пользователя не меняет.
// https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shqueryusernotificationstate
using System;
using System.Runtime.InteropServices;

internal static class NotificationState
{
    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    private static int Main()
    {
        int state;
        if (SHQueryUserNotificationState(out state) < 0) return 1;
        Console.WriteLine(state);
        return 0;
    }
}
