import { app, desktopCapturer, dialog, screen, shell, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { applicationLogs, latestRevitLog } from './logs';
import type { ReportBackend } from './service';
export function reportBackend(win: BrowserWindow, logs: string): Omit<ReportBackend, 'metadata'> {
  return {
    readApplication: () => applicationLogs(logs),
    readRevit: (year) => latestRevitLog(process.env.LOCALAPPDATA ?? '', year),
    screens: () =>
      screen
        .getAllDisplays()
        .slice(0, 16)
        .map((display, index) => ({
          id: String(display.id),
          label: `Экран ${index + 1} (${display.size.width}×${display.size.height})`,
        })),
    capture: async (target) => {
      let image;
      if (target.type === 'window') image = await win.webContents.capturePage();
      else {
        if (!screen.getAllDisplays().some((display) => String(display.id) === target.id))
          throw Error('invalid_screen');
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
          fetchWindowIcons: false,
        });
        image = sources.find((source) => source.display_id === target.id)?.thumbnail;
        if (!image) throw Error('screen_unavailable');
      }
      const size = image.getSize(),
        factor = Math.min(1, 1920 / size.width, 1080 / size.height);
      if (factor < 1)
        image = image.resize({
          width: Math.max(1, Math.round(size.width * factor)),
          height: Math.max(1, Math.round(size.height * factor)),
        });
      return image.toPNG();
    },
    choose: async (fileName) => {
      const result = await dialog.showSaveDialog(win, {
        title: 'Сохранить архив диагностики',
        defaultPath: join(app.getPath('downloads'), fileName),
        filters: [{ name: 'ZIP-архив', extensions: ['zip'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      });
      return result.canceled ? null : (result.filePath ?? null);
    },
    reveal: (path) => shell.showItemInFolder(path),
  };
}
