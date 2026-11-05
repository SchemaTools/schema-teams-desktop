import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToastSpec } from '../../src/main/notifications/types';
interface Contents extends EventEmitter {
  send: ReturnType<typeof vi.fn>;
  mainFrame: { url: string };
}
interface Win extends EventEmitter {
  webContents: Contents;
  showInactive: ReturnType<typeof vi.fn>;
}
const f = vi.hoisted(() => ({ windows: [] as Win[], ipc: undefined as EventEmitter | undefined }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  f.ipc = new EventEmitter();
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      bounds = { x: 0, y: 0, width: 364, height: 258 };
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
        send: vi.fn(),
        mainFrame: { url: '' },
      });
      constructor() {
        super();
        f.windows.push(this as unknown as Win);
      }
      isDestroyed() {
        return this.destroyed;
      }
      close() {
        if (!this.destroyed) {
          this.destroyed = true;
          this.emit('closed');
        }
      }
      loadURL = async (url: string) => {
        this.webContents.mainFrame.url = url;
      };
      showInactive = vi.fn();
      getBounds = () => this.bounds;
      setBounds = (b: typeof this.bounds) => {
        this.bounds = b;
      };
    },
    ipcMain: f.ipc,
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    }),
  };
});
import { CustomToasts } from '../../src/main/notifications/toasts';
import { customToastPage } from '../../src/main/notifications/page';

const services: CustomToasts[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.destroy();
  f.windows.length = 0;
});
const spec = (): ToastSpec => ({
  key: 'chat:4',
  id: 'chat:4',
  groupId: 'chat:4',
  delayMs: 0,
  title: 'Объект А',
  body: '2 новых сообщений\nИванова И.И.: текст',
  buttons: ['Открыть', 'Прочитано'],
  hasReply: true,
});
async function shown() {
  const onReply = vi.fn(async () => ({ ok: true as const }));
  const onShow = vi.fn();
  const beforeShow = vi.fn(() => true);
  const s = new CustomToasts({ beforeShow, onReply, onButton: vi.fn(), onShow, onClose: vi.fn() });
  services.push(s);
  s.show(spec());
  const win = f.windows[0];
  if (!win) throw Error('no window');
  await Promise.resolve();
  win.emit('ready-to-show');
  await vi.waitFor(() => expect(onShow).toHaveBeenCalledTimes(1));
  const reply = (text: string) =>
    f.ipc?.emit(
      'desktop:toast',
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      { action: 'reply', text },
    );
  return { s, win, onReply, onShow, beforeShow, reply };
}

describe('быстрый ответ и обновление уведомления', () => {
  it('поле ответа ограничено лимитом API 4000 знаков', () => {
    const html = decodeURIComponent(customToastPage(spec()));
    expect(html).toContain('maxlength="4000"');
  });
  it('ответ длиннее 4000 не отправляется, причина понятна, поле остаётся', async () => {
    const { win, onReply, reply } = await shown();
    reply('а'.repeat(4001));
    expect(onReply).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('desktop:toast-result', {
      ok: false,
      message: expect.stringContaining('длиннее 4000 знаков'),
    });
    reply('а'.repeat(4000));
    await vi.waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  });
  it('update меняет текст показанного уведомления без нового показа, проверок и звука', async () => {
    const { s, win, onShow, beforeShow } = await shown();
    expect(s.update('chat:4', 'Иванова И.И.: текст')).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('desktop:toast-update', {
      body: 'Иванова И.И.: текст',
    });
    expect(f.windows).toHaveLength(1);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(beforeShow).toHaveBeenCalledTimes(1);
    expect(s.update('chat:5', 'нет такого')).toBe(false);
  });
});
