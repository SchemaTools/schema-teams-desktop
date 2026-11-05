// Точка входа главного процесса.
import { app, Menu, protocol, session, shell, type Tray } from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';
import { readBuildConfig, resolveServerUrl } from './config';
import { Logger } from './logger';
import { MainWindow, PARTITION } from './mainWindow';
import { permissionAllowed } from './navigation';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { ClientHost } from './clientHost';
import { desktopShutdown } from './desktop/updateShutdown';
import { applyAutostart, autostartAvailable } from './desktop/autostart';
import { TeamsApi } from './api/client';
import { parseServerUrl } from './navigation';
import { switchServer } from './desktop/switchServer';
import { scanRevit } from './desktop/revitInventory';
import { reportBackend } from './diagnostics/backend';
import { cleanupDesktopUpdateStaging } from './desktop/updateFactory';

export const APP_ID = 'SchemaTeams.Desktop';
/** Ключ автозапуска: окно не показывается, только значок (ТЗ, 4.4) */
const HIDDEN_ARG = '--hidden';
// Chromium 152 starts a separate, non-sandboxed DX12 information collector
// after 120 seconds on Windows. Desktop does not use that optional report;
// skip this short-lived process while keeping the normal rendering GPU process.
if (process.platform === 'win32')
  app.commandLine.appendSwitch('disable-gpu-process-for-dx12-info-collection');
protocol.registerSchemesAsPrivileged([
  { scheme: 'schema-attachment', privileges: { standard: true, secure: true } },
]);

// Переменные разработки и сквозных тестов действуют только в неупакованной сборке:
// у установленного приложения адрес сервера и профиль окружением не подменить.
const devEnv = (name: 'SCHEMA_TEAMS_SERVER_URL' | 'SCHEMA_TEAMS_USER_DATA') =>
  app.isPackaged ? undefined : process.env[name];
// отдельная папка данных — для сквозных тестов, чтобы не трогать настоящий профиль
const devUserData = devEnv('SCHEMA_TEAMS_USER_DATA');
if (devUserData) app.setPath('userData', devUserData);
/** Отдельный профиль (тесты, замер памяти упакованной сборки через --user-data-dir) — без автозапуска. */
const isolatedProfile = devUserData || app.commandLine.getSwitchValue('user-data-dir') || undefined;

const log = new Logger({ dir: join(app.getPath('userData'), 'logs') });

let quitting = false;
let main: MainWindow | undefined;
let tray: Tray | undefined;
export let client: ClientHost | undefined;

if (!app.requestSingleInstanceLock()) {
  // приложение уже запущено — оно само покажет окно (second-instance)
  app.quit();
} else {
  app.on('second-instance', () => main?.show());
  process.on('uncaughtException', (err) => log.error('необработанная ошибка', { err }));
  process.on('unhandledRejection', (err) => log.error('необработанный отказ', { err }));
  app.whenReady().then(start, (err: unknown) => log.error('запуск не удался', { err }));
}

function start(): void {
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'));
  const build = readBuildConfig(join(app.getAppPath(), 'dist', 'build-config.json'));
  const server = resolveServerUrl({
    env: devEnv('SCHEMA_TEAMS_SERVER_URL'),
    settings: settings.get().serverUrl,
    build: build.serverUrl,
  });
  const hidden = process.argv.includes(HIDDEN_ARG);

  log.info('запуск', {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    windows: release(),
    packaged: app.isPackaged,
    hidden,
    server: server?.origin ?? null,
  });

  const setAutostart = (enabled: boolean) => applyAutostart(app, enabled, isolatedProfile);
  if (settings.get().onboardingComplete) setAutostart(settings.get().autostart);

  tray = createTray({
    version: app.getVersion(),
    onClick: () => main?.toggle(),
    onOpen: () => main?.show(),
    onQuit: () => app.quit(),
    onMenu: (bounds) => client?.showMenu(bounds),
  });
  // Старые загрузки обновлений (прошлые запуски) убираются в фоне, текущих ещё нет.
  void cleanupDesktopUpdateStaging().catch(() => {});
  const environmentServer = parseServerUrl(devEnv('SCHEMA_TEAMS_SERVER_URL'));
  function mount(notice?: string): void {
    if (quitting || !tray) return;
    desktopShutdown.assertMayReplace();
    const previous = main;
    const selected = resolveServerUrl({
      env: devEnv('SCHEMA_TEAMS_SERVER_URL'),
      settings: settings.get().serverUrl,
      build: build.serverUrl,
    });
    const partition = settings.get().serverPartition ?? PARTITION;
    restrictPermissions(selected, partition);
    main = new MainWindow({ server: selected, settings, log, isQuitting: () => quitting });
    client = new ClientHost({
      main,
      server: selected,
      uncHosts: build.uncHosts,
      partition,
      settings,
      log,
      tray,
      serverLocked: Boolean(environmentServer),
      connectionNotice: notice,
      report: reportBackend(main.win, join(app.getPath('userData'), 'logs')),
      readRevit: () =>
        scanRevit({
          programFiles: process.env.ProgramW6432 ?? process.env.ProgramFiles ?? '',
          appData: app.getPath('appData'),
          programData: process.env.ProgramData ?? '',
        }),
      checkServer: async (candidate) => {
        const probe = session.fromPartition('server-health-probe', { cache: false });
        const api = new TeamsApi({
          fetch: (path, init) =>
            probe.fetch(new URL(path, candidate.origin).href, {
              ...init,
              redirect: 'manual',
              credentials: 'omit',
              cache: 'no-store',
            }),
        });
        return api.health();
      },
      activateServer: async (candidate) => {
        desktopShutdown.assertMayReplace();
        await switchServer(candidate, {
          settings,
          stop: () => {
            desktopShutdown.assertMayReplace();
            client?.prepareServerSwitch();
            client?.destroy();
            client = undefined;
          },
          clear: async () => {
            const old = session.fromPartition(partition);
            await old.closeAllConnections();
            await old.clearStorageData();
            await old.clearCache();
            await old.cookies.flushStore();
          },
          mount,
        });
      },
      applyAutostart: setAutostart,
      autostartAvailable: autostartAvailable(app, isolatedProfile),
      openLogs: () => shell.openPath(join(app.getPath('userData'), 'logs')),
    });
    previous?.destroy();
    if (!hidden || previous) main.win.once('ready-to-show', () => main?.show());
  }
  mount();
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  // cookie входа должны лечь на диск до выхода, иначе пароль спросят снова (ТЗ, 2.2)
  e.preventDefault();
  log.info('выход');
  void (async () => {
    try {
      client?.destroy();
    } catch (err) {
      log.error('ошибка завершения клиента', { err });
    }
    try {
      await session.fromPartition(client?.partition ?? PARTITION).cookies.flushStore();
    } catch (err) {
      log.warn('cookie не сохранены', { err });
    } finally {
      try {
        tray?.destroy();
      } catch (err) {
        log.error('ошибка завершения клиента', { err });
      } finally {
        app.quit();
      }
    }
  })();
});

/**
 * Разрешения страницам: только копирование в буфер и полный экран, и только серверу.
 * Камера, микрофон, геопозиция и прочее — запрещены. Уведомления — через мост (шаг Д3).
 * Источник — сам запрос (кадр, который спрашивает), а не адрес окна: встроенный
 * кадр чужого сайта на странице сервера разрешения не получает.
 */
function restrictPermissions(server: URL | null, partition = PARTITION): void {
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, perm, cb, details) =>
    cb(permissionAllowed(server, perm, details.requestingUrl)),
  );
  ses.setPermissionCheckHandler((_wc, perm, origin, details) =>
    permissionAllowed(server, perm, origin, details.requestingUrl),
  );
  // Окно входа и API не скачивают файлы через раздел cookie: вложения читает main сам.
  ses.removeAllListeners('will-download');
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    item.cancel();
  });
}
