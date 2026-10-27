// Только чтение: системные режимы не изменяются, команды и пути не принимаются.
// SHQueryUserNotificationState не определяет современный Focus Assist сам по себе.
// WNF-проверка недокументирована; источник/ограничения: docs/native-notification-state.md.
using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class NotificationState
{
    [DllImport("shell32.dll")]
    private static extern int SHQueryUserNotificationState(out int state);

    // Недокументированный API. Читаем исключительно один фиксированный DWORD;
    // нет NtUpdateWnfStateData, подписки на события или изменений параметров Windows.
    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtQueryWnfStateData(
        ref ulong stateName,
        IntPtr typeId,
        IntPtr explicitScope,
        out uint changeStamp,
        out uint buffer,
        ref uint bufferSize);

    private static int? ReadShellState()
    {
        try
        {
            int state;
            if (SHQueryUserNotificationState(out state) >= 0 && state >= 1 && state <= 7)
                return state;
        }
        catch (Exception)
        {
            // В stderr не выводим исключения/окружение; неизвестное состояние — null.
        }
        return null;
    }

    private static int? ReadFocusState()
    {
        try
        {
            // WNF_SHEL_QUIETHOURS_ACTIVE_PROFILE_CHANGED:
            // 0 — выключен; 1 — только приоритетные; 2 — только будильники.
            ulong stateName = 0x0D83063EA3BF1C75UL;
            uint size = sizeof(uint);
            uint stamp;
            uint profile;
            int status = NtQueryWnfStateData(
                ref stateName, IntPtr.Zero, IntPtr.Zero, out stamp, out profile, ref size);
            if (status >= 0 && size == sizeof(uint) && profile <= 2)
                return (int)profile;
        }
        catch (Exception)
        {
            // Отсутствующий API, другая ABI или ошибка чтения не означают «выключен».
        }
        return null;
    }

    private static string JsonNumber(int? value)
    {
        return value.HasValue ? value.Value.ToString(CultureInfo.InvariantCulture) : "null";
    }

    private static int Main()
    {
        // Версия отличает результат от старого helper, печатавшего только shell=5.
        // Каждый запрос независим: ошибка одного не скрывает результат другого.
        int? shell = ReadShellState();
        int? focus = ReadFocusState();
        Console.WriteLine("{\"v\":1,\"shell\":" + JsonNumber(shell) +
            ",\"focus\":" + JsonNumber(focus) + "}");
        return 0;
    }
}
