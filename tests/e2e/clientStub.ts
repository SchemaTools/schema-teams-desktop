import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from 'socket.io';
import type {
  ChatFile,
  ChatMessage,
  ChatSummary,
  NotificationItem,
  ObjectInfo,
} from '../../src/shared/client';

export interface FixtureCall {
  method: string;
  path: string;
  userId: number | null;
  csrf: string | null;
  requestId: string | null;
  cookie: string | null;
  body: Record<string, unknown> | null;
  contentType?: string;
  fileName?: string;
  bytes?: number;
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
  uploadStatus: number | null;
  uploadDelayMs: number;
  reactionStatus: number | null;
  reactionDelayMs: number;
  canWrite: boolean;
  canPin: boolean;
  mutationStatus: number | null;
  mutationDelayMs: number;
  typingReceived: number[];
  objectChat: boolean;
  objectInfoStatus: number | null;
  objectInfoDelayMs: number;
  objectInfo: ObjectInfo;
}
const names: Record<number, string> = { 1: 'Иванова И.И.', 2: 'Петров П.П.' };
const csrfFor = (id: number) => `csrf-test-only-user-${id}`;
export const fixtureObject = (): ObjectInfo => ({
  id: 7,
  code: 'ОБ-А',
  name: 'Объект А',
  fullName: 'Тестовый объект бюро',
  client: 'Тестовый заказчик',
  address: 'Условный адрес',
  status: 'active',
  statusNote: null,
  gip: { id: 1, shortName: names[1] ?? '' },
  gap: { id: 2, shortName: names[2] ?? '' },
  pm: null,
  folderRoot: '\\\\server\\share\\object-a',
  modelPath: '\\\\server\\share\\object-a\\model.rvt',
  currentStageId: 71,
  stages: [
    {
      id: 71,
      code: 'Р',
      name: 'Рабочая документация',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      closed: false,
    },
  ],
});
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
    uploadStatus: null,
    uploadDelayMs: 0,
    reactionStatus: null,
    reactionDelayMs: 0,
    canWrite: true,
    canPin: true,
    mutationStatus: null,
    mutationDelayMs: 0,
    typingReceived: [],
    objectChat: false,
    objectInfoStatus: null,
    objectInfoDelayMs: 0,
    objectInfo: fixtureObject(),
  };
  const sessions = new Map<string, number>();
  const uploads = new Map<number, { file: ChatFile; chatId: number; userId: number }>();
  const pins = new Map<number, number>();
  let nextFileId = 2000;
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
    const isObject = state.objectChat && chatId === 4;
    return {
      id: chatId,
      kind: isObject ? 'object' : 'direct',
      title: isObject ? 'ОБ-А · Объект А' : user === 1 ? 'Тестовый чат' : 'Другой разговор',
      peer: isObject
        ? null
        : { id: user === 1 ? 2 : 1, shortName: names[user === 1 ? 2 : 1] ?? '' },
      objectId: isObject ? 7 : null,
      objectCode: isObject ? 'ОБ-А' : null,
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
    socket.on('chat:typing', (data: { chatId?: unknown }) => {
      if (typeof data?.chatId === 'number') state.typingReceived.push(data.chatId);
    });
    void socket.join(`user:${socket.data.userId}`);
  });

  async function respond(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const user = userOf(req);
    let body: Record<string, unknown> | null = null;
    let rawBody = Buffer.alloc(0);
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      rawBody = Buffer.concat(chunks);
      try {
        body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
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
        ...(path.endsWith('/files') && {
          contentType: String(req.headers['content-type'] ?? ''),
          fileName: String(req.headers['x-file-name'] ?? ''),
          bytes: rawBody.length,
        }),
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
    if (path === '/api/objects/7' && method === 'GET') {
      if (user !== 1 || !state.objectChat) {
        denied(res, 'not_found', 404);
        return;
      }
      if (state.objectInfoDelayMs)
        await new Promise<void>((done) => setTimeout(done, state.objectInfoDelayMs));
      if (state.objectInfoStatus) {
        denied(res, 'forbidden', state.objectInfoStatus);
        return;
      }
      json(res, 200, state.objectInfo);
      return;
    }
    const fileRoute = /^\/api\/files\/(\d+)$/.exec(path);
    if (fileRoute && method === 'GET') {
      const id = Number(fileRoute[1]);
      const file = files.get(id);
      const accessible =
        conversations
          .get(chatOf(user))
          ?.some((m) => !m.deleted && m.files.some((f) => f.fileId === id)) ||
        uploads.get(id)?.userId === user;
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
    const upload = /^\/api\/chats\/(\d+)\/files$/.exec(path);
    if (upload && method === 'POST') {
      const chatId = Number(upload[1]);
      if (chatId !== chatOf(user)) {
        denied(res, 'not_found', 404);
        return;
      }
      if (!state.canWrite) {
        denied(res, 'read_only', 403);
        return;
      }
      if (state.uploadDelayMs)
        await new Promise<void>((done) => setTimeout(done, state.uploadDelayMs));
      if (state.uploadStatus) {
        denied(res, state.uploadStatus === 403 ? 'forbidden' : 'server_error', state.uploadStatus);
        return;
      }
      let fileName: string;
      try {
        fileName = decodeURIComponent(String(req.headers['x-file-name'] ?? ''));
      } catch {
        denied(res, 'validation', 400);
        return;
      }
      if (!fileName || !rawBody.length || rawBody.length > 50 * 1024 * 1024) {
        denied(res, 'validation', 400);
        return;
      }
      const mime = rawBody.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? 'image/png'
        : 'application/octet-stream';
      const file: ChatFile = {
        fileId: nextFileId++,
        fileName,
        size: rawBody.length,
        mime,
        isImage: mime === 'image/png',
      };
      uploads.set(file.fileId, { file, chatId, userId: user });
      files.set(file.fileId, { bytes: rawBody, mime });
      json(res, 201, file);
      return;
    }
    const reaction = /^\/api\/chats\/(\d+)\/messages\/(\d+)\/reactions(?:\/([a-z]+))?$/.exec(path);
    if (reaction && ['POST', 'DELETE'].includes(method)) {
      const chatId = Number(reaction[1]),
        messageId = Number(reaction[2]);
      const message = conversations.get(chatId)?.find((m) => m.id === messageId && !m.deleted);
      if (chatId !== chatOf(user) || !message) {
        denied(res, 'not_found', 404);
        return;
      }
      if (state.reactionDelayMs)
        await new Promise<void>((done) => setTimeout(done, state.reactionDelayMs));
      if (state.reactionStatus) {
        denied(
          res,
          state.reactionStatus === 403 ? 'forbidden' : 'server_error',
          state.reactionStatus,
        );
        return;
      }
      const kind = method === 'POST' ? body?.kind : reaction[3];
      if (
        typeof kind !== 'string' ||
        !['like', 'heart', 'done', 'look', 'laugh', 'question'].includes(kind)
      ) {
        denied(res, 'validation', 400);
        return;
      }
      const values = message.reactions.filter((r) => r.kind !== kind);
      const users =
        message.reactions.find((r) => r.kind === kind)?.users.filter((u) => u.id !== user) ?? [];
      if (method === 'POST') users.push({ id: user, shortName: names[user] ?? 'Тест' });
      if (users.length) values.push({ kind, users });
      message.reactions = values;
      json(res, 200, values);
      io.to(`user:${user}`).emit('chat:reaction', { chatId, messageId, reactions: values });
      return;
    }
    const mutation = /^\/api\/chats\/(\d+)\/messages\/(\d+)$/.exec(path);
    const search = /^\/api\/chats\/(\d+)\/search$/.exec(path);
    if (search && method === 'GET') {
      const id = Number(search[1]);
      if (id !== chatOf(user)) {
        denied(res, 'not_found', 404);
        return;
      }
      const q = url.searchParams.get('q')?.trim().slice(0, 100) ?? '';
      json(
        res,
        200,
        q.length < 2
          ? []
          : (conversations.get(id) ?? [])
              .filter(
                (m) => !m.deleted && m.text.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
              )
              .slice(-30)
              .reverse(),
      );
      return;
    }
    if (mutation && ['PATCH', 'DELETE'].includes(method)) {
      const chatId = Number(mutation[1]),
        messageId = Number(mutation[2]),
        target = conversations.get(chatId)?.find((m) => m.id === messageId);
      if (chatId !== chatOf(user) || !target) {
        denied(res, 'not_found', 404);
        return;
      }
      if (!state.canWrite || !target.canEdit || target.author?.id !== user || target.deleted) {
        denied(res, 'forbidden', 403);
        return;
      }
      if (state.mutationDelayMs)
        await new Promise<void>((done) => setTimeout(done, state.mutationDelayMs));
      if (state.mutationStatus) {
        denied(res, 'forbidden', state.mutationStatus);
        return;
      }
      if (method === 'PATCH') {
        if (typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
          denied(res, 'validation', 400);
          return;
        }
        target.text = body.text.trim();
        target.editedAt = new Date().toISOString();
      } else {
        target.deleted = true;
        target.text = '';
        target.files = [];
        target.reactions = [];
        target.mentions = [];
        target.canEdit = false;
        if (pins.get(chatId) === messageId) pins.delete(chatId);
      }
      for (const m of conversations.get(chatId) ?? [])
        if (m.replyTo?.id === messageId)
          m.replyTo = {
            id: messageId,
            authorShortName: target.author?.shortName ?? null,
            preview: target.text.slice(0, 200),
            deleted: target.deleted,
          };
      json(res, 200, target);
      io.to(`user:${user}`).emit('chat:update', target);
      return;
    }
    const chat = /^\/api\/chats\/(\d+)(?:\/(messages|read|pin))?$/.exec(path);
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
          canWrite: state.canWrite,
          pinned: (() => {
            const m = messages.find((m) => m.id === pins.get(id) && !m.deleted);
            return m
              ? { id: m.id, authorShortName: m.author?.shortName ?? null, preview: m.text }
              : null;
          })(),
          canPin: state.canPin,
          taskStageId: null,
        });
        return;
      }
      if (chat[2] === 'pin' && method === 'POST') {
        if (!state.canPin || !state.canWrite) {
          denied(res, 'forbidden', 403);
          return;
        }
        if (state.mutationStatus) {
          denied(res, 'forbidden', state.mutationStatus);
          return;
        }
        const target =
          body?.messageId === null
            ? null
            : messages.find((m) => m.id === body?.messageId && !m.deleted);
        if (target === undefined) {
          denied(res, 'validation', 400);
          return;
        }
        if (target) pins.set(id, target.id);
        else pins.delete(id);
        json(res, 200, { ok: true });
        io.to(`user:${user}`).emit('chat:pin', { chatId: id });
        return;
      }
      if (chat[2] === 'messages' && method === 'GET') {
        const before = Number(url.searchParams.get('before')) || null;
        const after = Number(url.searchParams.get('after')) || null;
        const found = messages.filter(
          (message) => (!before || message.id < before) && (!after || message.id > after),
        );
        const around = Number(url.searchParams.get('around')) || null;
        const index = around === null ? -1 : found.findIndex((m) => m.id === around);
        const start =
          index >= 0
            ? Math.max(0, Math.min(index - 25, found.length - 50))
            : Math.max(0, found.length - 50);
        const items = found.slice(start, start + 50);
        json(res, 200, {
          items,
          hasMore: start > 0,
          hasNewer: start + items.length < found.length,
        });
        return;
      }
      if (chat[2] === 'messages' && method === 'POST') {
        if (!state.canWrite) {
          denied(res, 'read_only', 403);
          return;
        }
        if (state.sendDelayMs)
          await new Promise<void>((done) => setTimeout(done, state.sendDelayMs));
        const requestId =
          typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
        const fileIds = body?.fileIds ?? [];
        const replyTarget =
          body?.replyTo === undefined ? null : messages.find((m) => m.id === body.replyTo);
        if (
          !requestId ||
          (body?.replyTo !== undefined && !replyTarget) ||
          typeof body?.text !== 'string' ||
          (!body.text.trim() && !(Array.isArray(fileIds) && fileIds.length > 0)) ||
          body.text.length > 4000 ||
          !Array.isArray(fileIds) ||
          fileIds.length > 10 ||
          new Set(fileIds).size !== fileIds.length ||
          fileIds.some(
            (fileId) =>
              !Number.isSafeInteger(fileId) ||
              !uploads.has(Number(fileId)) ||
              uploads.get(Number(fileId))?.chatId !== id ||
              uploads.get(Number(fileId))?.userId !== user,
          )
        ) {
          denied(res, 'validation', 400);
          return;
        }
        const key = `${user}:${id}:${requestId}`;
        let message = idempotency.get(key);
        if (!message) {
          message = fixtureMessage(nextId++, id, body.text, user);
          if (replyTarget)
            message.replyTo = {
              id: replyTarget.id,
              authorShortName: replyTarget.author?.shortName ?? null,
              preview: replyTarget.text.slice(0, 200),
              deleted: replyTarget.deleted,
            };
          message.files = fileIds.flatMap((fileId) => {
            const uploaded = uploads.get(Number(fileId));
            return uploaded ? [uploaded.file] : [];
          });
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
        } else if (
          message.text !== body.text ||
          (message.replyTo?.id ?? null) !== (body?.replyTo ?? null) ||
          JSON.stringify(message.files.map((f) => f.fileId)) !== JSON.stringify(fileIds)
        ) {
          denied(res, 'idempotency_conflict', 409);
          return;
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
    notifications: events,
    messages: (chatId = 4) => conversations.get(chatId) ?? [],
    push: (text: string, chatId = 4, emit = true) => {
      const message = fixtureMessage(nextId++, chatId, text, chatId === 4 ? 2 : 1);
      conversations.get(chatId)?.push(message);
      unread.set(chatId, (unread.get(chatId) ?? 0) + 1);
      if (emit) io.to(`user:${chatId === 4 ? 1 : 2}`).emit('chat:message', message);
      return message;
    },
    disconnect: () => io.disconnectSockets(true),
    typing: (shortName = 'Петров П.П.', chatId = 4, userId = 2) =>
      io.to(`user:${chatId === 4 ? 1 : 2}`).emit('chat:typing', { chatId, userId, shortName }),
    close: () => new Promise<void>((done) => io.close(() => done())),
  };
}
export type ClientStub = Awaited<ReturnType<typeof startClientStub>>;
