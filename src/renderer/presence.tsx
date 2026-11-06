// «Кто в сети» в окне: отдельное хранилище вне снимка клиента. Главный процесс шлёт его
// своим сообщением (`client:presence`), а точки и подписи подписаны каждая на своего
// сотрудника — событие присутствия перерисовывает только их, не ленту и не список.
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import type { PresenceView } from '../shared/client';
import { request } from './bridge';
import { N } from './newChatStrings';

interface Store {
  epoch: number;
  online: ReadonlySet<number>;
  lastSeen: ReadonlyMap<number, string>;
}
let store: Store = { epoch: -1, online: new Set(), lastSeen: new Map() };
const listeners = new Set<() => void>();

/** Принять снимок главного процесса; чужой вход (другое поколение) — только новее. */
export function acceptPresence(view: PresenceView): void {
  if (!view || typeof view.epoch !== 'number' || view.epoch < store.epoch) return;
  store = {
    epoch: view.epoch,
    online: new Set(Array.isArray(view.online) ? view.online : []),
    lastSeen: new Map(
      Object.entries(view.lastSeen ?? {}).map(([id, at]) => [Number(id), String(at)]),
    ),
  };
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Текущий вход и связь: без связи или при другом входе точки не показываются. */
export const PresenceScope = createContext<{ epoch: number; live: boolean }>({
  epoch: -1,
  live: false,
});

/** В сети ли сотрудник — подписка только на его значение. */
export function useOnline(userId: number | null | undefined): boolean {
  const scope = useContext(PresenceScope);
  return useSyncExternalStore(
    subscribe,
    () =>
      scope.live &&
      typeof userId === 'number' &&
      store.epoch === scope.epoch &&
      store.online.has(userId),
  );
}
function useLastSeen(userId: number): string | null {
  const scope = useContext(PresenceScope);
  return useSyncExternalStore(subscribe, () =>
    store.epoch === scope.epoch ? (store.lastSeen.get(userId) ?? null) : null,
  );
}

/** Подписка на присутствие и снимок при каждом новом входе (поколении). */
export function usePresenceFeed(epoch: number, signedIn: boolean): void {
  useEffect(() => {
    if (!window.teams?.subscribePresence) return;
    return window.teams.subscribePresence(acceptPresence);
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    void request({ kind: 'presence.read', epoch }).then((result) => {
      if (result.ok) acceptPresence(result.data);
    });
  }, [epoch, signedIn]);
}

/** Зелёная точка у аватара (макет v4, экран 1: `.av .on`). */
export function PresenceDot({ userId }: { userId: number }) {
  const online = useOnline(userId);
  return online ? <span className="presence-dot" data-presence-dot={userId} /> : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Дата и время в поясе бюро: [день как ключ, «14:05», «5 ноября»]. */
function zoned(at: Date, timeZone?: string): { day: string; time: string; label: string } {
  const options = timeZone ? { timeZone } : {};
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('ru-RU', {
      ...options,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return zoned(at);
  }
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const label = new Intl.DateTimeFormat('ru-RU', { ...options, day: 'numeric', month: 'long' })
    .format(at)
    .replace(/\s*г\.$/, '');
  return {
    day: `${get('year')}-${pad(get('month'))}-${pad(get('day'))}`,
    time: `${pad(get('hour'))}:${pad(get('minute'))}`,
    label,
  };
}
/** «в сети», «был(а) в сети в 14:05 / вчера в … / 5 ноября в …», «не в сети». */
export function presenceText(
  online: boolean,
  lastSeen: string | null,
  timeZone?: string,
  now = Date.now(),
): string {
  if (online) return N.online;
  const at = lastSeen ? new Date(lastSeen) : null;
  if (!at || Number.isNaN(at.getTime())) return N.offlineStatus;
  const seen = zoned(at, timeZone);
  const today = zoned(new Date(now), timeZone);
  const yesterday = zoned(new Date(now - 86400000), timeZone);
  if (seen.day === today.day) return N.seenToday(seen.time);
  if (seen.day === yesterday.day) return N.seenYesterday(seen.time);
  return N.seenOn(seen.label, seen.time);
}
/** Подпись в шапке личного чата; перерисовывается только по своему сотруднику. */
export function PresenceStatus({ userId, timeZone }: { userId: number; timeZone?: string }) {
  const online = useOnline(userId);
  const scope = useContext(PresenceScope);
  const lastSeen = useLastSeen(userId);
  if (!scope.live) return null;
  return (
    <span className={`presence-status${online ? ' is-online' : ''}`} data-presence-status={userId}>
      {presenceText(online, lastSeen, timeZone)}
    </span>
  );
}
