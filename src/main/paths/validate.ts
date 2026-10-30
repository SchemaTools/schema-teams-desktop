// UNC передаётся Win32 Shell как путь, не как URL. Ничего не декодируем и
// не нормализуем: неоднозначные варианты должны быть отклонены до fs/Shell.
// Правила имён: https://learn.microsoft.com/windows/win32/fileio/naming-a-file
const MAX_PATH_LENGTH = 32767;
const MAX_COMPONENT_LENGTH = 255;
const UNSAFE_CHARACTERS = /[<>:"/|?*%]|[\p{Cc}\p{Cf}\p{Cs}]/u;
const HOST_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?$/u;
const DOS_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$)$/u;
const NON_FILE_SHARES = new Set(['IPC$', 'PIPE', 'MAILSLOT']);

function componentValid(component: string): boolean {
  if (
    component === '' ||
    component.length > MAX_COMPONENT_LENGTH ||
    component === '.' ||
    component === '..' ||
    component.trim() !== component ||
    component.endsWith('.')
  )
    return false;
  // Win32 распознаёт DOS-устройства и при расширении, в том числе NUL.txt.
  const base = (component.split('.')[0] ?? '').trimEnd().toUpperCase();
  return !DOS_DEVICE.test(base);
}

export function validateUncPath(input: unknown): string | null {
  if (
    typeof input !== 'string' ||
    input.length > MAX_PATH_LENGTH ||
    !input.startsWith('\\\\') ||
    UNSAFE_CHARACTERS.test(input)
  )
    return null;

  // Единственная разрешённая канонизация — обычный завершающий разделитель папки.
  // Повторные разделители, включая два завершающих, останутся пустым компонентом.
  const path = input.endsWith('\\') ? input.slice(0, -1) : input;
  const components = path.slice(2).split('\\');
  const host = components[0];
  const share = components[1];
  if (!host || !share || host.length > 253) return null;
  if (!host.split('.').every((label) => label.length <= 63 && HOST_LABEL.test(label))) return null;
  if (NON_FILE_SHARES.has(share.toUpperCase())) return null;
  if (!components.slice(1).every(componentValid)) return null;
  return path;
}

const REVEAL_EXTENSIONS = new Set([
  // Обязательный список ТЗ 6.2.
  'EXE',
  'MSI',
  'BAT',
  'CMD',
  'COM',
  'SCR',
  'PS1',
  'VBS',
  'VBE',
  'JS',
  'JSE',
  'WSF',
  'HTA',
  'LNK',
  'REG',
  'CPL',
  'JAR',
  // Другие ярлыки, установщики и системные ассоциации, запускающие код/команды.
  'URL',
  'SCF',
  'PIF',
  'APPREF-MS',
  'APPLICATION',
  'APPX',
  'APPXBUNDLE',
  'MSIX',
  'MSIXBUNDLE',
  'MSU',
  'MSP',
  'SCT',
  'WSH',
  'PSC1',
  'MSC',
  'GADGET',
  'PSM1',
  'PY',
  'PYW',
  'SH',
  'BASH',
  'PL',
  'RB',
  'CHM',
  'DIAGCAB',
  'SEARCH-MS',
]);

// Опасный суффикс проверяется и у папки: между stat и Shell тип может измениться.
export function pathNeedsReveal(path: string, kind: 'file' | 'directory' = 'file'): boolean {
  const valid = validateUncPath(path);
  // Даже ошибочный вызов классификатора не должен разрешать запуск плохого пути.
  if (valid === null) return true;
  const name = valid.slice(valid.lastIndexOf('\\') + 1);
  const dot = name.lastIndexOf('.');
  // У файла без расширения неизвестна ассоциация: безопаснее показать его в папке.
  if (dot < 0) return kind === 'file';
  // Верхний регистр также ловит Unicode-варианты вроде длинной s в расширении JS.
  return REVEAL_EXTENSIONS.has(name.slice(dot + 1).toUpperCase());
}
