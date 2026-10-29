// Socket.IO работает только в main. Cookie не передаётся renderer и не журналируется.
import { io } from 'socket.io-client';

export const REALTIME_EVENTS = [
  'notification',
  'chat:message',
  'chat:update',
  'chat:read',
  'chat:list',
  'chat:reaction',
  'chat:typing',
  'chat:pin',
  'chat:poll',
  'chat:stickers',
  'chat:presence',
  'time:timer',
  'session',
  'focus',
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];
type Listener = (...args: unknown[]) => void;

/** Минимальная поверхность Socket.IO для проверяемого управления жизненным циклом. */
export interface RealtimeSocket {
  on(event: string, listener: Listener): void;
  off(event: string, listener: Listener): void;
  connect(): void;
  disconnect(): void;
  emit(event: string, data: unknown): void;
}
export interface RealtimeSocketOptions {
  path: '/socket.io';
  transports: ['websocket'];
  extraHeaders: { Cookie: string };
  reconnection: false;
  autoConnect: false;
  forceNew: true;
  timeout: number;
}
export type SocketFactory = (url: string, options: RealtimeSocketOptions) => RealtimeSocket;
export interface RealtimeOptions {
  server: URL;
  /** Только value URL-scoped cookie st_session; её чтение выполняет владелец Session. */
  getCookie: () => Promise<string | null>;
  getEpoch: () => number;
  onEvent: (name: RealtimeEvent, data: unknown) => void;
  onStatus: (online: boolean) => void;
  createSocket?: SocketFactory;
}

const DELAYS = [1000, 2000, 5000, 10000, 30000] as const;
const TIMEOUT = 15000;

const createSocket: SocketFactory = (url, options) => {
  // Этот файл компилируется tsc в Node CJS, а не browser bundle: пакет выбирает
  // Node transport, где extraHeaders действительно входят в WebSocket handshake.
  const socket = io(url, options);
  return {
    on: (event, listener) => {
      socket.on(event, listener);
    },
    off: (event, listener) => {
      socket.off(event, listener);
    },
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    emit: (event, data) => {
      socket.emit(event, data);
    },
  };
};

interface Active {
  socket: RealtimeSocket;
  listeners: [string, Listener][];
  generation: number;
  epoch: number;
  typingAt?: number;
}

export class RealtimeClient {
  private running = false;
  private generation = 0;
  private epoch: number | undefined;
  private active?: Active;
  private pending?: Promise<void>;
  private retry?: ReturnType<typeof setTimeout>;
  private delayIndex = 0;
  private status?: boolean;
  private readonly cancelCookie = new Set<() => void>();

  constructor(private readonly o: RealtimeOptions) {}

  start(): Promise<void> {
    const epoch = this.o.getEpoch();
    if (this.running && this.epoch === epoch) return this.pending ?? Promise.resolve();
    this.retire();
    // Новый вход получает собственное подтверждение connect, даже если прежняя
    // сессия закончилась в состоянии online без явного stop вызывающей стороны.
    this.status = undefined;
    this.running = true;
    this.epoch = epoch;
    this.delayIndex = 0;
    const generation = this.generation;
    if (
      !['http:', 'https:'].includes(this.o.server.protocol) ||
      this.o.server.username ||
      this.o.server.password
    ) {
      this.running = false;
      this.publish(false);
      return Promise.resolve();
    }
    return this.connect(generation, epoch);
  }

  stop(): void {
    this.retire();
    this.publish(false);
  }
  typing(chatId: number): boolean {
    const active = this.active;
    if (
      !active ||
      !Number.isSafeInteger(chatId) ||
      chatId <= 0 ||
      !this.status ||
      !this.current(active.generation, active.epoch)
    )
      return false;
    const now = Date.now();
    if (active.typingAt !== undefined && now - active.typingAt < 3000) return false;
    active.typingAt = now;
    active.socket.emit('chat:typing', { chatId });
    return true;
  }

  private current(generation: number, epoch: number): boolean {
    return (
      this.running &&
      this.generation === generation &&
      this.epoch === epoch &&
      this.o.getEpoch() === epoch
    );
  }

  private connect(generation: number, epoch: number): Promise<void> {
    const task = this.attempt(generation, epoch).finally(() => {
      if (this.pending === task) this.pending = undefined;
    });
    this.pending = task;
    return task;
  }

  private async attempt(generation: number, epoch: number): Promise<void> {
    const value = await this.readCookie();
    if (!this.current(generation, epoch)) return;
    // RFC cookie-octet: в заголовок не допускаются пробелы, управляющие символы,
    // кавычки, запятая, точка с запятой и обратная косая черта.
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > 4096 ||
      !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)
    ) {
      this.publish(false);
      this.schedule(generation, epoch);
      return;
    }
    let active: Active | undefined;
    try {
      const socket = (this.o.createSocket ?? createSocket)(this.o.server.origin, {
        path: '/socket.io',
        transports: ['websocket'],
        extraHeaders: { Cookie: `st_session=${value}` },
        reconnection: false,
        autoConnect: false,
        forceNew: true,
        timeout: TIMEOUT,
      });
      active = { socket, listeners: [], generation, epoch };
      this.active = active;
      const own = active;
      const valid = () => this.active === own && this.current(generation, epoch);
      const listen = (event: string, listener: Listener) => {
        own.listeners.push([event, listener]);
        socket.on(event, listener);
      };
      const failed = () => {
        if (!valid()) return;
        this.dispose(own);
        this.publish(false);
        this.schedule(generation, epoch);
      };
      listen('connect', () => {
        if (!valid()) return;
        this.delayIndex = 0;
        this.publish(true);
      });
      listen('disconnect', failed);
      listen('connect_error', failed);
      for (const event of REALTIME_EVENTS)
        listen(event, (data) => {
          if (valid()) this.o.onEvent(event, data);
        });
      socket.connect();
    } catch {
      if (active) this.dispose(active);
      if (!this.current(generation, epoch)) return;
      this.publish(false);
      this.schedule(generation, epoch);
    }
  }

  private readCookie(): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: string | null | undefined) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.cancelCookie.delete(cancel);
        resolve(value);
      };
      const cancel = () => finish(undefined);
      const timer = setTimeout(() => finish(null), TIMEOUT);
      this.cancelCookie.add(cancel);
      Promise.resolve()
        .then(() => (done ? undefined : this.o.getCookie()))
        .then(
          (value) => finish(value),
          () => finish(null),
        );
    });
  }

  private schedule(generation: number, epoch: number): void {
    if (!this.current(generation, epoch) || this.retry) return;
    const delay = DELAYS[Math.min(this.delayIndex++, DELAYS.length - 1)] ?? 30000;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.current(generation, epoch)) void this.connect(generation, epoch);
    }, delay);
  }

  private dispose(active: Active): void {
    if (this.active === active) this.active = undefined;
    for (const [event, listener] of active.listeners) active.socket.off(event, listener);
    active.socket.disconnect();
  }

  private retire(): void {
    this.running = false;
    this.generation++;
    this.epoch = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
    for (const cancel of [...this.cancelCookie]) cancel();
    if (this.active) this.dispose(this.active);
    this.pending = undefined;
  }

  private publish(online: boolean): void {
    if (this.status === online) return;
    this.status = online;
    this.o.onStatus(online);
  }
}
