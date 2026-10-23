// Sandboxed preload: runtime-import только Electron, общий протокол используется как тип.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, DesktopCommandName } from '../bridge/protocol';

const originArg = process.argv.find((arg) => arg.startsWith('--schema-server-origin='));
const origin = originArg
  ? decodeURIComponent(originArg.slice('--schema-server-origin='.length))
  : '';
const allowed = () => origin !== '' && location.origin === origin && window === window.top;
const events = new Set([
  'hello',
  'signedOut',
  'counters',
  'notify',
  'timer',
  'focus',
  'connection',
  'openPath',
]);
const commands = new Set(['navigate', 'reply', 'markRead', 'timer', 'focus', 'windowState']);

if (allowed()) {
  const handlers = new Map<DesktopCommandName, (data: unknown) => Promise<unknown>>();
  const bridge: DesktopBridge = {
    send(event, data) {
      if (!allowed() || !events.has(event)) return undefined;
      return ipcRenderer
        .invoke('desktop:event', event, data)
        .catch(() => (event === 'openPath' ? 'blocked' : undefined));
    },
    on(name, handler) {
      if (allowed() && commands.has(name) && typeof handler === 'function')
        handlers.set(name, handler);
    },
  };
  ipcRenderer.on('desktop:command', async (_event, message: unknown) => {
    if (!allowed() || !message || typeof message !== 'object') return;
    const input = message as { id?: unknown; name?: unknown; data?: unknown };
    if (typeof input.id !== 'string' || input.id.length > 100 || typeof input.name !== 'string')
      return;
    const handler = handlers.get(input.name as DesktopCommandName);
    let result: unknown = { ok: false, error: '' };
    if (input.name === 'openNotifications') {
      // Селектор проверен в серверном NotificationBell.tsx; API серверного репозитория не меняется.
      const bell = document.querySelector<HTMLButtonElement>(
        '.nt > button[aria-haspopup="dialog"]',
      );
      if (bell) {
        if (bell.getAttribute('aria-expanded') !== 'true') bell.click();
        result = { ok: true };
      }
    } else if (handler) {
      try {
        result = await handler(input.data);
      } catch {
        /* main выберет безопасный текст */
      }
    }
    if (allowed()) ipcRenderer.send('desktop:result', { id: input.id, result });
  });
  let warning = '';
  const renderWarning = () => {
    document.getElementById('schema-desktop-warning')?.remove();
    if (!warning || !document.documentElement) return;
    const host = document.createElement('div');
    host.id = 'schema-desktop-warning';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = new CSSStyleSheet();
    style.replaceSync(
      ':host{position:fixed;top:0;left:0;right:0;z-index:2147483647;display:block}div{font:14px/1.4 Arial,sans-serif;background:#fff0c2;color:#5c3b00;padding:10px 16px;border-bottom:1px solid #d1ad50;box-shadow:0 2px 5px #0002}',
    );
    shadow.adoptedStyleSheets = [style];
    const bar = document.createElement('div');
    bar.setAttribute('role', 'alert');
    bar.textContent = warning;
    shadow.append(bar);
    document.documentElement.append(host);
  };
  ipcRenderer.on('desktop:compatibility', (_event, value: unknown) => {
    warning = typeof value === 'string' ? value : '';
    renderWarning();
  });
  window.addEventListener('DOMContentLoaded', renderWarning);
  contextBridge.exposeInMainWorld('schemaDesktop', bridge);
}
