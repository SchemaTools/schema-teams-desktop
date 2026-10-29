// Точка входа главного процесса.
import { app, Menu, protocol, session, shell, type Tray } from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';
import { readBuildConfig, resolveServerUrl } from './config';
import { Logger } from './logger';
import { MainWindow, PARTITION } from './mainWindow';
import { isServerUrl } from './navigation';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { ClientHost } from './clientHost';
import { applyAutostart, autostartAvailable } from './desktop/autostart';

export const APP_ID = 'SchemaTeams.Desktop';
/** Ключ автозапуска: окно не показывается, только значок (ТЗ, 4.4) */
const HIDDEN_ARG = '--hidden';
protocol.registerSchemesAsPrivileged([
  { scheme: 'schema-attachment', privileges: { standard: true, secure: true } },
]);

// отдельная папка данных — для сквозных тестов, чтобы не трогать настоящий профиль
if (process.env.SCHEMA_TEAMS_USER_DATA) app.setPath('userData', process.env.SCHEMA_TEAMS_USER_DATA);

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
    env: process.env.SCHEMA_TEAMS_SERVER_URL,
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

  restrictPermissions(server);
  const setAutostart = (enabled: boolean) =>
    applyAutostart(app, enabled, process.env.SCHEMA_TEAMS_USER_DATA);
  setAutostart(settings.get().autostart);

  main = new MainWindow({ server, settings, log, isQuitting: () => quitting });
  tray = createTray({
    version: app.getVersion(),
    onClick: () => main?.toggle(),
    onOpen: () => main?.show(),
    onQuit: () => app.quit(),
    onMenu: (bounds) => client?.showMenu(bounds),
  });
  client = new ClientHost({
    main,
    server,
    settings,
    log,
    tray,
    applyAutostart: setAutostart,
    autostartAvailable: autostartAvailable(app, process.env.SCHEMA_TEAMS_USER_DATA),
    openLogs: () => shell.openPath(join(app.getPath('userData'), 'logs')),
  });
  if (!hidden) main.win.once('ready-to-show', () => main?.show());
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  // cookie входа должны лечь на диск до выхода, иначе пароль спросят снова (ТЗ, 2.2)
  e.preventDefault();
  log.info('выход');
  client?.destroy();
  session
    .fromPartition(PARTITION)
    .cookies.flushStore()
    .catch((err: unknown) => log.warn('cookie не сохранены', { err }))
    .finally(() => {
      tray?.destroy();
      app.quit();
    });
});

/**
 * Разрешения страницам: только копирование в буфер и полный экран, и только серверу.
 * Камера, микрофон, геопозиция и прочее — запрещены. Уведомления — через мост (шаг Д3).
 */
function restrictPermissions(server: URL | null): void {
  const ses = session.fromPartition(PARTITION);
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const ok = (perm: string, origin: string) =>
    allowed.has(perm) && server !== null && isServerUrl(origin, server);
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(ok(perm, wc.getURL())));
  ses.setPermissionCheckHandler((_wc, perm, origin) => ok(perm, origin));
}
