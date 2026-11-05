import type { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToastSpec } from '../../src/main/notifications/types';
interface Win extends EventEmitter {
  showInactive: ReturnType<typeof vi.fn>;
  isDestroyed(): boolean;
  close(): void;
}
const f = vi.hoisted(() => ({ windows: [] as Win[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    // тема окна уведомления (замечание 3): в тестах — светлая
    nativeTheme: { shouldUseDarkColors: false },
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      bounds = { x: 0, y: 0, width: 364, height: 258 };
      webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: vi.fn(),
        session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
        send: vi.fn(),
      });
      constructor() {
        super();
        f.windows.push(this);
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
      loadURL = async () => {};
      showInactive = vi.fn();
      getBounds = () => this.bounds;
      setBounds = (b: typeof this.bounds) => {
        this.bounds = b;
      };
    },
    ipcMain: new EventEmitter(),
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    }),
  };
});
import { CustomToasts } from '../../src/main/notifications/toasts';
import { desktopShutdown } from '../../src/main/desktop/updateShutdown';
const leases: { release(): void }[] = [],
  services: CustomToasts[] = [];
afterEach(() => {
  for (const l of leases.splice(0)) l.release();
  for (const s of services.splice(0)) s.destroy();
  f.windows.length = 0;
});
const spec = (hasReply = true): ToastSpec => ({
  key: 'fixture',
  id: 'fixture',
  groupId: 'fixture',
  delayMs: 0,
  title: 'Fixture',
  body: 'Inert',
  buttons: [],
  hasReply,
});
function service(beforeShow: () => Promise<boolean> | boolean = () => true) {
  const onShow = vi.fn(),
    s = new CustomToasts({
      beforeShow,
      onReply: async () => ({ ok: true }),
      onButton: vi.fn(),
      onShow,
      onClose: vi.fn(),
    });
  services.push(s);
  return { s, onShow };
}
function lease() {
  const l = desktopShutdown.acquire(() => true);
  if (!l) throw Error('missing lease');
  leases.push(l);
  return l;
}
describe('Popup replies participate in updater shutdown; no native windows or messages', () => {
  it('a clean reply surface blocks even before ready/draft IPC and clears only on close', () => {
    const { s } = service();
    expect(s.hasReplySurface).toBe(false);
    expect(s.show(spec())).toBe(true);
    expect(s.hasReplySurface).toBe(true);
    expect(f.windows[0]?.showInactive).not.toHaveBeenCalled();
    f.windows[0]?.close();
    expect(s.hasReplySurface).toBe(false);
  });
  it('new show is denied before constructing a window while the global lease is held', () => {
    const { s, onShow } = service();
    lease();
    expect(s.show(spec())).toBe(false);
    expect(f.windows).toHaveLength(0);
    expect(onShow).not.toHaveBeenCalled();
  });
  it('an async policy success cannot show even a nonreply popup after a lease begins', async () => {
    let finish!: (value: boolean) => void;
    const pending = new Promise<boolean>((r) => {
        finish = r;
      }),
      { s, onShow } = service(() => pending);
    expect(s.show(spec(false))).toBe(true);
    const win = f.windows[0];
    if (!win) throw Error('missing window');
    win.emit('ready-to-show');
    lease();
    finish(true);
    await vi.waitFor(() => expect(win.isDestroyed()).toBe(true));
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(onShow).not.toHaveBeenCalled();
  });
  it('holding a lease never auto-closes an existing visible reply or loses its text surface', async () => {
    const { s } = service();
    s.show(spec());
    const win = f.windows[0];
    if (!win) throw Error('missing window');
    win.emit('ready-to-show');
    await vi.waitFor(() => expect(win.showInactive).toHaveBeenCalledOnce());
    lease();
    expect(s.show({ ...spec(), id: 'another' })).toBe(false);
    expect(win.isDestroyed()).toBe(false);
    expect(s.hasReplySurface).toBe(true);
  });
});
