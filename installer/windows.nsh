; Дополнение к установщику NSIS (electron-builder, nsis.include).
; Регистрация приложения для уведомлений Windows: без раздела AppUserModelId Windows 10
; не показывает уведомления на экране и прячет поле ответа (опыт Д2, docs/decisions.md).
; Значения — как в src/main/appIdentity.ts.

!define ST_AUMID_KEY "Software\Classes\AppUserModelId\SchemaTeams.Desktop"
!define ST_TOAST_CLSID "{3A439A27-D1AC-4ACC-83AB-0C513448DBA8}"

!macro customInstall
  WriteRegStr HKCU "${ST_AUMID_KEY}" "DisplayName" "Schema Teams"
  WriteRegExpandStr HKCU "${ST_AUMID_KEY}" "IconUri" "$INSTDIR\uninstallerIcon.ico"
  WriteRegStr HKCU "${ST_AUMID_KEY}" "CustomActivator" "${ST_TOAST_CLSID}"
!macroend

!macro customUnInstall
  ; при обновлении старый удалитель запускается перед установкой — регистрацию не трогаем
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "${ST_AUMID_KEY}"
    DeleteRegKey HKCU "Software\Classes\CLSID\${ST_TOAST_CLSID}"
  ${endIf}
!macroend
