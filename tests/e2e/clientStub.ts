import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type { ChatMessage, ChatSummary, NotificationItem } from '../../src/shared/client';

export interface FixtureCall {
  method: string;
  path: string;
  userId: number | null;
  csrf: string | null;
  requestId: string | null;
  cookie: string | null;
  body: Record<string, unknown> | null;
}
export interface FixtureState {
  loginUserId: 1 | 2;
  healthOnline: boolean;
  mustChangePassword: boolean;
  lostAckOnce: boolean;
  sendDelayMs: number;
  socketConnections: number;
  socketCookies: string[];
  focusUntil: string | null;
  calls: FixtureCall[];
}
const names: Record<number, string> = { 1: 'Иванова И.И.', 2: 'Петров П.П.' };
const csrfFor = (id: number) => `csrf-test-only-user-${id}`;
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const denied = (res: ServerResponse, code: string, status = 401) =>
  json(res, status, { error: { code } });
export const fixtureMessage = (
  id: number,
  chatId: number,
  text: string,
  author = 2,
): ChatMessage => ({
  id,
  chatId,
  author: { id: author, shortName: names[author] ?? 'Сидоров С.С.' },
  text,
  at: new Date().toISOString(),
  editedAt: null,
  deleted: false,
  replyTo: null,
  files: [],
  mentions: [],
  links: [],
  canEdit: author === 1,
  reactions: [],
  cards: [],
  sticker: null,
  poll: null,
});

export async function startClientStub() {
  const files = new Map<number, { bytes: Buffer; mime: string; status?: number }>();
  const state: FixtureState = {
    loginUserId: 1,
    healthOnline: true,
    mustChangePassword: false,
    lostAckOnce: false,
    sendDelayMs: 0,
    socketConnections: 0,
    socketCookies: [],
    focusUntil: null,
    calls: [],
  };
  const sessions = new Map<string, number>();
  const conversations = new Map<number, ChatMessage[]>([
    [
      4,
      [
        fixtureMessage(101, 4, 'Исходные данные готовы'),
        fixtureMessage(102, 4, 'Проверьте узел 5'),
      ],
    ],
    [8, [fixtureMessage(301, 8, 'Разговор второго пользователя', 1)]],
  ]);
  const unread = new Map<number, number>([
    [4, 2],
    [8, 1],
  ]);
  const idempotency = new Map<string, ChatMessage>();
  const events: NotificationItem[] = [
    {
      id: 71,
      event: 'album_assigned',
      at: new Date().toISOString(),
      read: false,
      author: { id: 2, shortName: names[2] ?? '', photoFileId: null },
      task: {
        id: 21,
        kind: 'album',
        mark: 'АР1',
        title: 'Тестовая задача',
        objectName: 'Объект А',
        stageCode: 'Р',
      },
      changes: [],
      reason: null,
      subject: 'Назначена задача',
      link: '/albums/21',
    },
  ];
  let nextId = 400;
  const userOf = (req: IncomingMessage) => {
    const token = /(?:^|;\s*)st_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    return token ? (sessions.get(token) ?? null) : null;
  };
  const chatOf = (user: number) => (user === 1 ? 4 : 8);
  const summary = (chatId: number, user: number): ChatSummary => {
    const last = conversations.get(chatId)?.at(-1) ?? null;
    return {
      id: chatId,
      kind: 'direct',
      title: user === 1 ? 'Тестовый чат' : 'Другой разговор',
      peer: { id: user === 1 ? 2 : 1, shortName: names[user === 1 ? 2 : 1] ?? '' },
      objectId: null,
      objectCode: null,
      memberCount: 2,
      last: last
        ? {
            id: last.id,
            authorShortName: last.author?.shortName ?? null,
            authorId: last.author?.id ?? null,
            preview: last.text,
            at: last.at,
            deleted: last.deleted,
          }
        : null,
      unread: unread.get(chatId) ?? 0,
      mentioned: false,
      photoFileId: null,
    };
  };
  const server = createServer((req, res) => {
    void respond(req, res).catch(() => {
      if (!res.headersSent) denied(res, 'internal', 500);
      else res.end();
    });
  });
  const io = new Server(server, { transports: ['websocket'], serveClient: false });
  io.use((socket, next) => {
    const user = userOf(socket.request);
    if (!user) {
      next(new Error('unauthenticated'));
      return;
    }
    socket.data.userId = user;
    state.socketCookies.push(socket.request.headers.cookie ?? '');
    next();
  });
  io.on('connection', (socket) => {
    state.socketConnections++;
    void socket.join(`user:${socket.data.userId}`);
  });

  async function respond(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const user = userOf(req);
    let body: Record<string, unknown> | null = null;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        body = null;
      }
    }
    if (path.startsWith('/api/'))
      state.calls.push({
        method,
        path: `${path}${url.search}`,
        userId: user,
        csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : null,
        requestId:
          typeof req.headers['idempotency-key'] === 'string'
            ? req.headers['idempotency-key']
            : null,
        cookie: req.headers.cookie ?? null,
        body,
      });
    if (path === '/login' || path === '/signed-in') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход в тестовый Teams</title></head><body><h1>Вход на стенд</h1><button id="sign-in">Войти на стенд</button><script>document.getElementById("sign-in").onclick=async()=>{await fetch("/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({login:"test-user"})});location.href="/signed-in";};</script></body></html>',
      );
      return;
    }
    if (path === '/api/health') {
      json(res, state.healthOnline ? 200 : 503, {
        status: state.healthOnline ? 'ok' : 'error',
        db: state.healthOnline ? 'ok' : 'down',
        version: '0.11.2',
      });
      return;
    }
    if (path === '/api/auth/login' && method === 'POST') {
      const token = `fixture-session-${randomUUID()}`;
      sessions.set(token, state.loginUserId);
      res.setHeader(
        'set-cookie',
        `st_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600`,
      );
      json(res, 200, { ok: true });
      return;
    }
    if (!user) {
      denied(res, 'unauthenticated');
      return;
    }
    if (path === '/api/auth/me') {
      json(res, 200, {
        user: {
          id: user,
          shortName: names[user],
          fullName: names[user],
          login: `user-${user}`,
          mustChangePassword: state.mustChangePassword,
          roles: [],
          permissions: [],
        },
        csrfToken: csrfFor(user),
      });
      return;
    }
    const fileRoute = /^\/api\/files\/(\d+)$/.exec(path);
    if (fileRoute && method === 'GET') {
      const id = Number(fileRoute[1]);
      const file = files.get(id);
      const accessible = conversations
        .get(chatOf(user))
        ?.some((m) => !m.deleted && m.files.some((f) => f.fileId === id));
      if (!file || !accessible) {
        denied(res, 'not_found', 404);
        return;
      }
      res.writeHead(file.status ?? 200, {
        'content-type': file.mime,
        'content-length': String(file.bytes.length),
      });
      res.end(file.bytes);
      return;
    }
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
      req.headers['x-csrf-token'] !== csrfFor(user)
    ) {
      denied(res, 'csrf', 403);
      return;
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      const token = /(?:^|;\s*)st_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (token) sessions.delete(token);
      res.setHeader('set-cookie', 'st_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/api/chats') {
      json(res, 200, {
        items: [summary(chatOf(user), user)],
        unreadTotal: unread.get(chatOf(user)) ?? 0,
      });
      return;
    }
    const chat = /^\/api\/chats\/(\d+)(?:\/(messages|read))?$/.exec(path);
    if (chat) {
      const id = Number(chat[1]);
      if (id !== chatOf(user)) {
        denied(res, 'not_found', 404);
        return;
      }
      const messages = conversations.get(id) ?? [];
      if (!chat[2]) {
        json(res, 200, {
          chat: summary(id, user),
          members: [
            { user: { id: 1, shortName: names[1] }, readUpTo: 1, photoFileId: null },
            { user: { id: 2, shortName: names[2] }, readUpTo: 1, photoFileId: null },
          ],
          canManageMembers: false,
          canLeave: false,
          canWrite: true,
          pinned: null,
          canPin: false,
          taskStageId: null,
        });
        return;
      }
      if (chat[2] === 'messages' && method === 'GET') {
        const before = Number(url.searchParams.get('before')) || null;
        const after = Number(url.searchParams.get('after')) || null;
        const found = messages.filter(
          (message) => (!before || message.id < before) && (!after || message.id > after),
        );
        json(res, 200, { items: found.slice(-50), hasMore: found.length > 50, hasNewer: false });
        return;
      }
      if (chat[2] === 'messages' && method === 'POST') {
        if (state.sendDelayMs)
          await new Promise<void>((done) => setTimeout(done, state.sendDelayMs));
        const requestId =
          typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
        if (
          !requestId ||
          typeof body?.text !== 'string' ||
          !body.text.trim() ||
          body.text.length > 4000
        ) {
          denied(res, 'validation', 400);
          return;
        }
        const key = `${user}:${id}:${requestId}`;
        let message = idempotency.get(key);
        if (!message) {
          message = fixtureMessage(nextId++, id, body.text, user);
          idempotency.set(key, message);
          messages.push(message);
          conversations.set(id, messages);
          io.to(`user:${user}`).emit('chat:message', message);
          io.to(`user:${user}`).emit('chat:list');
          if (state.lostAckOnce) {
            state.lostAckOnce = false;
            denied(res, 'internal', 500);
            return;
          }
        }
        json(res, 200, message);
        return;
      }
      if (chat[2] === 'read' && method === 'POST') {
        unread.set(id, 0);
        json(res, 200, { ok: true });
        io.to(`user:${user}`).emit('chat:read', { chatId: id, userId: user, upTo: body?.upTo });
        return;
      }
    }
    if (path === '/api/notifications') {
      json(res, 200, {
        items: events,
        unread: events.filter((event) => !event.read).length,
        nextBefore: null,
      });
      return;
    }
    if (path === '/api/notifications/read-all' || /^\/api\/notifications\/\d+\/read$/.test(path)) {
      for (const event of events) event.read = true;
      json(res, 200, { ok: true });
      return;
    }
    if (path === '/api/notification-settings') {
      json(res, 200, { rows: [], digestHourly: false, quiet: null });
      return;
    }
    if (path === '/api/focus') {
      if (method === 'PUT') state.focusUntil = typeof body?.until === 'string' ? body.until : null;
      json(res, 200, {
        until: state.focusUntil,
        startedAt: state.focusUntil ? new Date().toISOString() : null,
      });
      return;
    }
    if (path === '/api/focus/summary') {
      json(res, 200, { messages: 0, mentions: 0, chats: [] });
      return;
    }
    denied(res, 'not_found', 404);
  }
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    state,
    files,
    messages: (chatId = 4) => conversations.get(chatId) ?? [],
    push: (text: string, chatId = 4, emit = true) => {
      const message = fixtureMessage(nextId++, chatId, text, chatId === 4 ? 2 : 1);
      conversations.get(chatId)?.push(message);
      unread.set(chatId, (unread.get(chatId) ?? 0) + 1);
      if (emit) io.to(`user:${chatId === 4 ? 1 : 2}`).emit('chat:message', message);
      return message;
    },
    disconnect: () => io.disconnectSockets(true),
    close: () => new Promise<void>((done) => io.close(() => done())),
  };
}
export type ClientStub = Awaited<ReturnType<typeof startClientStub>>;
