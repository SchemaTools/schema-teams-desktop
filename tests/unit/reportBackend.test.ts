import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
const h = vi.hoisted(() => ({
  displays: vi.fn(),
  sources: vi.fn(),
  save: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  screen: { getAllDisplays: h.displays },
  desktopCapturer: { getSources: h.sources },
  dialog: { showSaveDialog: h.save },
  shell: { showItemInFolder: h.reveal },
}));
import { reportBackend } from '../../src/main/diagnostics/backend';
const image = (width = 100, height = 80) => ({
  getSize: () => ({ width, height }),
  resize: vi.fn(function (this: unknown) {
    return this;
  }),
  toPNG: vi.fn(() => Buffer.from('fixture PNG')),
});
function fixture() {
  const capturePage = vi.fn(async () => image()),
    win = { webContents: { capturePage } } as unknown as BrowserWindow;
  return { capturePage, win, backend: reportBackend(win, '/logs') };
}
beforeEach(() => {
  vi.resetAllMocks();
  h.displays.mockReturnValue([
    { id: 11, size: { width: 1920, height: 1080 } },
    { id: 22, size: { width: 1280, height: 720 } },
  ]);
});
describe('Report native adapter', () => {
  it('enumerates only numeric display IDs and generic labels, never application/window titles', () => {
    const { backend } = fixture();
    expect(backend.screens()).toEqual([
      { id: '11', label: 'Экран 1 (1920×1080)' },
      { id: '22', label: 'Экран 2 (1280×720)' },
    ]);
    expect(h.sources).not.toHaveBeenCalled();
  });
  it('captures only its fixed own BrowserWindow when window is selected', async () => {
    const { backend, capturePage } = fixture();
    await backend.capture({ type: 'window' });
    expect(capturePage).toHaveBeenCalledTimes(1);
    expect(h.sources).not.toHaveBeenCalled();
  });
  it('selects exactly the requested display ID and bounds the resulting PNG dimensions', async () => {
    const { backend, capturePage } = fixture(),
      other = image(),
      selected = image(3840, 2160);
    h.sources.mockResolvedValue([
      { display_id: '11', thumbnail: other },
      { display_id: '22', thumbnail: selected },
    ]);
    await backend.capture({ type: 'screen', id: '22' });
    expect(other.toPNG).not.toHaveBeenCalled();
    expect(selected.resize).toHaveBeenCalledWith({ width: 1920, height: 1080 });
    expect(selected.toPNG).toHaveBeenCalledTimes(1);
    expect(capturePage).not.toHaveBeenCalled();
    expect(h.sources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 },
      fetchWindowIcons: false,
    });
  });
  it('does not fall back to a different monitor if a requested source disappears', async () => {
    const { backend } = fixture();
    h.sources.mockResolvedValue([{ display_id: '11', thumbnail: image() }]);
    await expect(backend.capture({ type: 'screen', id: '22' })).rejects.toThrow(
      'screen_unavailable',
    );
    h.sources.mockClear();
    await expect(backend.capture({ type: 'screen', id: '33' })).rejects.toThrow('invalid_screen');
    expect(h.sources).not.toHaveBeenCalled();
  });
  it('uses a native ZIP save dialog owned by the main window, cancellation returns no path', async () => {
    const { backend, win } = fixture();
    h.save.mockResolvedValue({ canceled: true, filePath: '/ignored' });
    expect(await backend.choose('report.zip')).toBeNull();
    expect(h.save).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        filters: [{ name: 'ZIP-архив', extensions: ['zip'] }],
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      }),
    );
    h.save.mockResolvedValue({ canceled: false, filePath: '/chosen/report.zip' });
    expect(await backend.choose('report.zip')).toBe('/chosen/report.zip');
  });
});
