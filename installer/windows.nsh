; Дополнение к установщику NSIS «в один щелчок» (electron-builder, nsis.include).
;
; При обновлении шаблон electron-builder ярлык «Пуска» не пересоздаёт (keepShortcuts),
; и Windows показывает в поиске старый значок из кэша (замечание руководителя 06.11 после
; 1.0.0 → 1.0.1). Здесь ярлык пересоздаётся с IconLocation на exe приложения и тем же
; AppUserModelID, что ставит шаблон (WinShell::SetLnkAUMI), затем SHChangeNotify
; (SHCNE_ASSOCCHANGED) сбрасывает кэш значков. Удалённый пользователем ярлык не возвращается.

!macro customInstall
  ${if} ${FileExists} "$newStartMenuLink"
    ; поверх, без удаления: плитка «Пуска», закреплённая по ярлыку, не теряется
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${endIf}
!macroend
