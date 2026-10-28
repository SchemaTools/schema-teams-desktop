import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RealtimeClient,
  type RealtimeSocket,
  type RealtimeSocketOptions,
} from '../../src/main/realtime/connection';

class Socket extends EventEmitter implements RealtimeSocket {
  connect = vi.fn<() => void>();
  disconnect = vi.fn<() => void>(() => {
    this.emit('disconnect', 'io client disconnect');
  });
}
const cleanups: (() => void)[] = [];
function fixture(
  getCookie = vi.fn<() => Promise<string | null>>().mockResolvedValue('opaque-session'),
) {
  let epoch = 1;
  const sockets: Socket[] = [];
  const createSocket = vi.fn<(url: string, options: RealtimeSocketOptions) => Socket>(() => {
    const socket = new Socket();
    sockets.push(socket);
    return socket;
  });
  const onEvent = vi.fn();
  const onStatus = vi.fn();
  const client = new RealtimeClient({
    server: new URL('https://example.test/'),
    getCookie,
    getEpoch: () => epoch,
    createSocket,
    onEvent,
    onStatus,
  });
  cleanups.push(() => client.stop());
  return { client, createSocket, sockets, getCookie, onEvent, onStatus, nextEpoch: () => ++epoch };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe('main Socket.IO session lifecycle', () => {
  it('uses a private websocket connection with the URL-scoped cookie header', async () => {
    const f = fixture();
    await Promise.all([f.client.start(), f.client.start(), f.client.start()]);
    expect(f.getCookie).toHaveBeenCalledTimes(1);
    expect(f.createSocket).toHaveBeenCalledExactlyOnceWith('https://example.test', {
      path: '/socket.io',
      transports: ['websocket'],
      extraHeaders: { Cookie: 'st_session=opaque-session' },
      reconnection: false,
      autoConnect: false,
      forceNew: true,
      timeout: 15000,
    });
    expect(f.sockets[0]?.connect).toHaveBeenCalledTimes(1);
    expect(f.onStatus).not.toHaveBeenCalled();
    f.sockets[0]?.emit('connect');
    f.sockets[0]?.emit('connect');
    expect(f.onStatus.mock.calls).toEqual([[true]]);
  });

  it('forwards only named server events and does not interpret session as logout', async () => {
    const f = fixture();
    await f.client.start();
    const socket = f.sockets[0];
    socket?.emit('connect');
    const data = { chatId: 4, userId: 2, upTo: 17 };
    socket?.emit('chat:read', data);
    socket?.emit('session');
    socket?.emit('chat:presence', { userId: 1, focusUntil: null });
    socket?.emit('unknown:command', { token: 'untrusted' });
    expect(f.onEvent.mock.calls).toEqual([
      ['chat:read', data],
      ['session', undefined],
      ['chat:presence', { userId: 1, focusUntil: null }],
    ]);
    expect(socket?.disconnect).not.toHaveBeenCalled();
    expect(f.onStatus.mock.calls).toEqual([[true]]);
  });

  it('uses exactly one retry timer and the 1/2/5/10/30 second backoff', async () => {
    const f = fixture();
    await f.client.start();
    for (const [index, seconds] of [1, 2, 5, 10, 30, 30].entries()) {
      const socket = f.sockets[index];
      socket?.emit('connect_error', new Error('not logged'));
      socket?.emit('disconnect');
      await vi.advanceTimersByTimeAsync(seconds * 1000 - 1);
      expect(f.createSocket).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.createSocket).toHaveBeenCalledTimes(index + 2);
      expect(socket?.disconnect).toHaveBeenCalledTimes(1);
    }
    expect(f.onStatus.mock.calls).toEqual([[false]]);
    expect(f.getCookie).toHaveBeenCalledTimes(7);
  });

  it('resets backoff after a real connect and disposes the previous connection', async () => {
    const f = fixture();
    await f.client.start();
    f.sockets[0]?.emit('connect_error');
    await vi.advanceTimersByTimeAsync(1000);
    f.sockets[1]?.emit('connect_error');
    await vi.advanceTimersByTimeAsync(2000);
    f.sockets[2]?.emit('connect');
    f.sockets[2]?.emit('disconnect');
    await vi.advanceTimersByTimeAsync(999);
    expect(f.sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sockets).toHaveLength(4);
    expect(f.onStatus.mock.calls).toEqual([[false], [true], [false]]);
    expect(f.sockets[0]?.listenerCount('chat:message')).toBe(0);
    f.sockets[0]?.emit('connect');
    expect(f.onStatus.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('stop settles an awaited cookie read and ignores its eventual old result', async () => {
    let finish!: (cookie: string | null) => void;
    const read = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture(read);
    const start = f.client.start();
    await Promise.resolve();
    f.client.stop();
    await start;
    finish('old-session');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.createSocket).not.toHaveBeenCalled();
    expect(f.onStatus.mock.calls).toEqual([[false]]);
  });

  it('does not connect using a cookie returned for an old session epoch', async () => {
    let finish!: (cookie: string | null) => void;
    const read = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    );
    const f = fixture(read);
    const start = f.client.start();
    await Promise.resolve();
    f.nextEpoch();
    finish('old-session');
    await start;
    expect(f.createSocket).not.toHaveBeenCalled();
    expect(f.onStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('stop before the next microtask does not start a needless cookie query', async () => {
    const f = fixture();
    const start = f.client.start();
    f.client.stop();
    await start;
    expect(f.getCookie).not.toHaveBeenCalled();
    expect(f.createSocket).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a new explicit start after epoch change retires old listeners and ignores late events', async () => {
    const f = fixture();
    await f.client.start();
    f.sockets[0]?.emit('connect');
    f.nextEpoch();
    f.sockets[0]?.emit('chat:message', { id: 8 });
    f.sockets[0]?.emit('disconnect');
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(f.onStatus.mock.calls).toEqual([[true]]);
    await f.client.start();
    expect(f.sockets).toHaveLength(2);
    expect(f.sockets[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(f.sockets[0]?.listenerCount('session')).toBe(0);
    f.sockets[1]?.emit('connect');
    f.sockets[1]?.emit('chat:list');
    expect(f.onEvent.mock.calls).toEqual([['chat:list', undefined]]);
    expect(f.onStatus.mock.calls).toEqual([[true], [true]]);
  });

  it.each([null, '', 'a\r\nInjected: yes', 'value; other=secret', 'a b', 'x'.repeat(4097)])(
    'rejects an invalid or missing cookie without constructing a socket: %s',
    async (cookie) => {
      const f = fixture(vi.fn<() => Promise<string | null>>().mockResolvedValue(cookie));
      await f.client.start();
      expect(f.createSocket).not.toHaveBeenCalled();
      expect(f.onStatus.mock.calls).toEqual([[false]]);
      expect(vi.getTimerCount()).toBe(1);
    },
  );

  it('cookie query rejection and timeout use the same bounded retry path', async () => {
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('private platform details'))
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue('new-session');
    const f = fixture(read);
    await f.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15000 + 1999);
    expect(f.createSocket).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(f.createSocket).toHaveBeenCalledTimes(1);
  });

  it('stop removes only its listeners and cancels reconnection', async () => {
    const f = fixture();
    await f.client.start();
    const socket = f.sockets[0];
    const independent = vi.fn();
    socket?.on('chat:list', independent);
    socket?.emit('connect_error');
    f.client.stop();
    await vi.advanceTimersByTimeAsync(120000);
    expect(f.sockets).toHaveLength(1);
    socket?.emit('chat:list');
    expect(independent).toHaveBeenCalledTimes(1);
    expect(f.onEvent).not.toHaveBeenCalled();
    expect(socket?.listenerCount('connect')).toBe(0);
  });
});
