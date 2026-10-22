// Точка входа главного процесса.
import { app, Menu, session, type Tray } from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';
import { readBuildConfig, resolveServerUrl } from './config';
import { Logger } from './logger';
import { MainWindow, PARTITION } from './mainWindow';
import { isServerUrl } from './navigation';
import { SettingsStore } from './settings';
import { createTray } from './tray';
import { ToastExperiment } from './experiments/toastExperiment';
import { experimentPage } from './pages';
import { APP_ID, TOAST_ACTIVATOR_CLSID } from './appIdentity';

/** Ключ автозапуска: окно не показывается, только значок (ТЗ, 4.4) */
const HIDDEN_ARG = '--hidden';
/** Так Windows запускает приложение из уведомления: окно покажет само нажатие, если нужно */
const EMBEDDING_ARG = '-Embedding';

// отдельная папка данных — для сквозных тестов, чтобы не трогать настоящий профиль
if (process.env.SCHEMA_TEAMS_USER_DATA) app.setPath('userData', process.env.SCHEMA_TEAMS_USER_DATA);
// до первого уведомления: код активатора должен совпадать с ярлыком и реестром (опыт Д2)
if (process.platform === 'win32') app.setToastActivatorCLSID(TOAST_ACTIVATOR_CLSID);

const log = new Logger({ dir: join(app.getPath('userData'), 'logs') });

let quitting = false;
let main: MainWindow | undefined;
let tray: Tray | undefined;

if (!app.requestSingleInstanceLock()) {
  // приложение уже запущено — оно само покажет окно (second-instance)
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!argv.includes(EMBEDDING_ARG)) main?.show();
  });
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
  const fromNotification = process.argv.includes(EMBEDDING_ARG);
  const hidden = process.argv.includes(HIDDEN_ARG) || fromNotification;

  log.info('запуск', {
    app: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    windows: release(),
    packaged: app.isPackaged,
    hidden,
    fromNotification,
    toastActivator: process.platform === 'win32' ? app.toastActivatorCLSID : null,
    server: server?.origin ?? null,
  });

  const experiment =
    build.experiment === 'toast' || process.env.SCHEMA_TEAMS_EXPERIMENT === 'toast';
  if (experiment) log.info('пробная сборка: опыт с уведомлениями');

  restrictPermissions(server);
  applyAutostart(settings.get().autostart);

  main = new MainWindow({
    server,
    settings,
    log,
    isQuitting: () => quitting,
    ...(experiment && { noServerPage: experimentPage() }),
  });
  const toast = experiment
    ? new ToastExperiment({
        log,
        isWindowVisible: () => main?.win.isVisible() ?? false,
        showWindow: () => main?.show(),
        fromNotification,
      })
    : undefined;
  tray = createTray({
    version: app.getVersion(),
    onClick: () => main?.toggle(),
    onOpen: () => main?.show(),
    onQuit: () => app.quit(),
    ...(toast && { extra: [toast.menu()] }),
  });
  if (!hidden) main.win.once('ready-to-show', () => main?.show());
}

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  // cookie входа должны лечь на диск до выхода, иначе пароль спросят снова (ТЗ, 2.2)
  e.preventDefault();
  log.info('выход');
  session
    .fromPartition(PARTITION)
    .cookies.flushStore()
    .catch((err: unknown) => log.warn('cookie не сохранены', { err }))
    .finally(() => {
      tray?.destroy();
      app.quit();
    });
});

/** Автозапуск с Windows (ТЗ, 4.4). Только у установленного приложения, не у разработки. */
function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_ARG] });
}

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
