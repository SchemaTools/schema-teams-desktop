import { describe, expect, it, vi } from 'vitest';
import type { PathKind } from '../../src/main/paths/probe';

// Все ОС-операции передаются сервису через зависимости, Electron здесь не запускается.
vi.mock('electron', () => ({ shell: {}, utilityProcess: {} }));
import { PathService } from '../../src/main/paths/service';

const root = String.raw`\\server\share`;
const file = root + String.raw`\Объект А\Модель.rvt`;
const folder = root + String.raw`\Объект А`;
function harness(trustedHost = true) {
  const probe = {
    inspect: vi.fn<(path: string) => Promise<PathKind | null>>().mockResolvedValue('file'),
    cancelAll: vi.fn<() => void>(),
  };
  const dialog = {
    show: vi.fn<(path: string) => void>(),
    close: vi.fn<() => void>(),
    destroy: vi.fn<() => void>(),
  };
  const shell = {
    openPath: vi.fn<(path: string) => Promise<string>>().mockResolvedValue(''),
    showItemInFolder: vi.fn<(path: string) => void>(),
  };
  const log = { info: vi.fn<(message: string, details?: Record<string, unknown>) => void>() };
  const trusted = vi.fn<(host: string) => boolean>().mockReturnValue(trustedHost);
  const confirm = vi.fn<(host: string) => Promise<boolean>>().mockResolvedValue(false);
  return {
    service: new PathService({ probe, dialog, shell, log, trusted, confirm }),
    probe,
    dialog,
    shell,
    log,
    trusted,
    confirm,
  };
}

describe('PathService', () => {
  it('негодные пути и reveal не выполняют проверок или ОС-действий', async () => {
    const { service, probe, dialog, shell, log } = harness();
    for (const path of [
      'relative.rvt',
      'file://server/share/file.rvt',
      String.raw`C:\file.rvt`,
      root + String.raw`\..\file.rvt`,
      String.raw`\\?\UNC\server\share\file.rvt`,
    ])
      await expect(service.open({ path, reveal: false })).resolves.toBe('blocked');
    await expect(service.open({ path: file, reveal: 'yes' as unknown as boolean })).resolves.toBe(
      'blocked',
    );
    expect(probe.inspect).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(dialog.show).not.toHaveBeenCalled();
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('file://server');
  });

  it.each([false, 'reject'] as const)(
    'хост не из списка: без подтверждения (%s) нет ни stat, ни Shell',
    async (answer) => {
      const { service, probe, shell, dialog, log, trusted, confirm } = harness(false);
      if (answer === 'reject') confirm.mockRejectedValue(new Error('dialog failure fixture'));
      else confirm.mockResolvedValue(answer);
      await expect(service.open({ path: file, reveal: true })).resolves.toBe('blocked');
      expect(trusted).toHaveBeenCalledExactlyOnceWith('server');
      expect(confirm).toHaveBeenCalledExactlyOnceWith('server');
      expect(probe.inspect).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(dialog.show).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('открытие пути', {
        path: file,
        result: 'blocked',
        reason: 'foreign-host-declined',
      });
    },
  );

  it('хост не из списка: stat начинается только после явного «Открыть»', async () => {
    const { service, probe, shell, log, confirm } = harness(false);
    let answer: ((value: boolean) => void) | undefined;
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const request = service.open({ path: file, reveal: true });
    await Promise.resolve();
    expect(probe.inspect).not.toHaveBeenCalled();
    if (!answer) throw new Error('Подтверждение не запрошено');
    answer(true);
    await expect(request).resolves.toBe('ok');
    expect(probe.inspect).toHaveBeenCalledExactlyOnceWith(file);
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(file);
    expect(log.info).toHaveBeenCalledWith('открытие пути', {
      path: file,
      result: 'ok',
      reason: 'foreign-host-confirmed',
    });
  });

  it('reset во время вопроса: позднее «Открыть» ничего не делает', async () => {
    const { service, probe, shell, confirm } = harness(false);
    let answer: ((value: boolean) => void) | undefined;
    confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const request = service.open({ path: file, reveal: true });
    await Promise.resolve();
    service.reset();
    answer?.(true);
    await expect(request).resolves.toBe('blocked');
    expect(probe.inspect).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it('доверенный хост открывается без вопроса', async () => {
    const { service, confirm, probe } = harness(true);
    await expect(service.open({ path: file, reveal: true })).resolves.toBe('ok');
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.inspect).toHaveBeenCalledOnce();
  });

  it.each(['file', 'directory'] as const)(
    'открывает доступный %s без дополнительных действий',
    async (kind) => {
      const { service, probe, dialog, shell, log } = harness();
      probe.inspect.mockResolvedValue(kind);
      const path = kind === 'directory' ? folder : file;
      await expect(service.open({ path, reveal: false })).resolves.toBe('ok');
      expect(probe.inspect).toHaveBeenCalledExactlyOnceWith(path);
      expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(path);
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(dialog.show).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('открытие пути', { path, result: 'ok' });
    },
  );

  it.each(['script.EXE', 'script.bat', 'shortcut.lnk', 'Модель.rvt.exe'])(
    'опасный файл %s только показывает в папке и возвращает blocked',
    async (name) => {
      const { service, shell, dialog } = harness();
      const path = root + '\\' + name;
      await expect(service.open({ path, reveal: false })).resolves.toBe('blocked');
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path);
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(dialog.show).not.toHaveBeenCalled();
    },
  );

  it.each(['Модель.rvt', 'script.bat'])(
    'явное «Показать в папке» для %s разрешено',
    async (name) => {
      const { service, shell } = harness();
      const path = root + '\\' + name;
      await expect(service.open({ path, reveal: true })).resolves.toBe('ok');
      expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path);
      expect(shell.openPath).not.toHaveBeenCalled();
    },
  );

  it('даже stat directory с суффиксом exe не позволяет запуск после подмены пути', async () => {
    const { service, probe, shell } = harness();
    probe.inspect.mockResolvedValue('directory');
    const path = root + String.raw`\Папка.exe`;
    await expect(service.open({ path, reveal: false })).resolves.toBe('blocked');
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(path);
  });

  it.each(['null', 'reject'] as const)(
    'ошибка stat (%s) показывает свой диалог и возвращает unavailable',
    async (outcome) => {
      const { service, probe, shell, dialog, log } = harness();
      if (outcome === 'null') probe.inspect.mockResolvedValue(null);
      else probe.inspect.mockRejectedValue(new Error('sensitive-probe-failure-fixture'));
      await expect(service.open({ path: file, reveal: false })).resolves.toBe('unavailable');
      expect(dialog.show).toHaveBeenCalledExactlyOnceWith(file);
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(log.info).toHaveBeenCalledWith('открытие пути', { path: file, result: 'unavailable' });
      expect(JSON.stringify(log.info.mock.calls)).not.toContain('sensitive-probe-failure-fixture');
    },
  );

  it.each(['returned-error', 'exception'] as const)(
    'ошибка Shell (%s) не раскрывается и показывает недоступность',
    async (outcome) => {
      const { service, shell, dialog, log } = harness();
      if (outcome === 'returned-error')
        shell.openPath.mockResolvedValue('sensitive-os-failure-fixture');
      else shell.openPath.mockRejectedValue(new Error('sensitive-os-failure-fixture'));
      await expect(service.open({ path: file, reveal: false })).resolves.toBe('unavailable');
      expect(dialog.show).toHaveBeenCalledExactlyOnceWith(file);
      expect(JSON.stringify(log.info.mock.calls)).not.toContain('sensitive-os-failure-fixture');
    },
  );

  it('ошибка reveal тоже завершается своим диалогом', async () => {
    const { service, shell, dialog } = harness();
    shell.showItemInFolder.mockImplementation(() => {
      throw new Error('reveal failure fixture');
    });
    await expect(service.open({ path: file, reveal: true })).resolves.toBe('unavailable');
    expect(dialog.show).toHaveBeenCalledExactlyOnceWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it('повтор одного выполняющегося запроса разделяет stat и действие Shell', async () => {
    const { service, probe, shell } = harness();
    let finish: ((kind: PathKind | null) => void) | undefined;
    probe.inspect.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.open({ path: file, reveal: false });
    const second = service.open({ path: file.toLowerCase(), reveal: false });
    expect(first).toBe(second);
    expect(probe.inspect).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Проверка пути не началась');
    finish('file');
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
    expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(file);
    probe.inspect.mockResolvedValue('file');
    await expect(service.open({ path: file, reveal: false })).resolves.toBe('ok');
    expect(probe.inspect).toHaveBeenCalledTimes(2);
    expect(shell.openPath).toHaveBeenCalledTimes(2);
  });

  it.each(['file', null] as const)(
    'reset отменяет ожидание: поздний stat %s не открывает Shell или диалог',
    async (outcome) => {
      const { service, probe, shell, dialog } = harness();
      let finish: ((kind: PathKind | null) => void) | undefined;
      probe.inspect.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const request = service.open({ path: file, reveal: false });
      service.reset();
      expect(probe.cancelAll).toHaveBeenCalledTimes(1);
      expect(dialog.close).toHaveBeenCalledTimes(1);
      if (!finish) throw new Error('Проверка пути не началась');
      finish(outcome);
      await expect(request).resolves.toBe('blocked');
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(dialog.show).not.toHaveBeenCalled();
    },
  );

  it('destroy очищает ресурсы и блокирует будущие запросы', async () => {
    const { service, probe, shell, dialog } = harness();
    service.destroy();
    expect(probe.cancelAll).toHaveBeenCalledTimes(1);
    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect(dialog.destroy).toHaveBeenCalledTimes(1);
    await expect(service.open({ path: file, reveal: false })).resolves.toBe('blocked');
    expect(probe.inspect).not.toHaveBeenCalled();
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
    expect(dialog.show).not.toHaveBeenCalled();
  });
});
