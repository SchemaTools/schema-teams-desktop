// Заглушка сервера Schema Teams для сквозных тестов: одна страница и cookie входа.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Stub {
  url: string;
  /** cookie st_session, с которыми приходили запросы главной страницы */
  seenSessions: string[];
  close: () => Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const seenSessions: string[] = [];
  let counter = 0;
  const server: Server = createServer((req, res) => {
    const cookie = /(?:^|;\s*)st_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (req.url === '/') {
      seenSessions.push(cookie ?? '');
      const headers: Record<string, string | string[]> = {
        'content-type': 'text/html; charset=utf-8',
      };
      // как сервер Teams: HttpOnly, SameSite=Strict, срок — 14 дней
      if (!cookie)
        headers['set-cookie'] =
          `st_session=s${++counter}; Path=/; HttpOnly; SameSite=Strict; Max-Age=1209600`;
      res.writeHead(200, headers);
      res.end(`<!doctype html><html><head><title>Заглушка Teams</title></head><body>
<h1 id="who">${cookie ? 'вошли' : 'вход'}</h1>
<a id="ext" href="https://example.com/">внешняя</a>
<a id="file" href="file:///C:/Windows/">файл</a>
<a id="blank" href="https://example.com/blank" target="_blank">новое окно</a>
</body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    seenSessions,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
