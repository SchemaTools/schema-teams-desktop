import { randomUUID } from 'node:crypto';
import type { SettingsStore } from '../settings';
interface Options {
  settings: SettingsStore;
  stop: () => void;
  clear: () => Promise<void>;
  mount: (notice?: string) => void;
}
/** Stop old work before clearing; never reuse an old server's authentication partition. */
export async function switchServer(server: URL, o: Options): Promise<void> {
  o.stop();
  try {
    await o.clear();
    o.settings.update({
      serverUrl: server.origin,
      serverPartition: `persist:teams-${randomUUID()}`,
      recentTimeTaskIds: {},
      timerReminderSeen: {},
    });
  } catch {
    o.mount(
      'Адрес не изменён: не удалось очистить данные подключения или сохранить настройки. Возможно, потребуется войти заново.',
    );
    throw new Error('configuration_failed');
  }
  o.mount();
}
