import type { DesktopRelease } from '../../src/shared/updates';
export const releaseFixture = (version = '1.1.0'): DesktopRelease => {
  const file = `Schema Teams Setup ${version}.exe`;
  return {
    version,
    notes: 'Исправлено сохранение настроек.\nОбновлён интерфейс.',
    file,
    sha256: 'a'.repeat(64),
    size: 112000000,
    url: `/api/desktop/files/${encodeURIComponent(file)}`,
  };
};
