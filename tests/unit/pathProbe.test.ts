import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UtilityProcess } from 'electron';

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }));
vi.mock('electron', () => ({ utilityProcess: { fork: forkMock } }));
import { PathProbe, PATH_STAT_TIMEOUT_MS } from '../../src/main/paths/probe';

type Transport = Pick<UtilityProcess, 'on' | 'postMessage' | 'kill'>;
class FakeChild extends EventEmitter {
  postMessage = vi.fn<(value: unknown) => void>();
  kill = vi.fn(() => true);
  // Electron возвращает полный UtilityProcess из перегруженного on(); для теста
  // нужны только регистрация/доставка событий и две команды транспорта.
  get transport(): Transport {
    return this as unknown as Transport;
  }
}
const path = String.raw`\\server\share\Модель.rvt`;

beforeEach(() => {
  vi.useFakeTimers();
  forkMock.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('PathProbe: ограниченный utility process без настоящего SMB', () => {
  it.each(['file', 'directory'] as const)(
    'принимает %s, завершает процесс и игнорирует последующие события',
    async (kind) => {
      const child = new FakeChild();
      child.kill.mockImplementation(() => {
        child.emit('exit', 0);
        return true;
      });
      const probe = new PathProbe(() => child.transport);
      const result = probe.inspect(path);
      expect(child.postMessage).toHaveBeenCalledExactlyOnceWith({ path });
      child.emit('message', kind);
      await expect(result).resolves.toBe(kind);
      child.emit('message', null);
      child.emit('exit', 0);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('через 3 секунды убивает зависший процесс и не принимает поздний результат', async () => {
    const child = new FakeChild();
    const result = new PathProbe(() => child.transport).inspect(path);
    let completed = false;
    void result.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(PATH_STAT_TIMEOUT_MS - 1);
    expect(completed).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit('message', 'file');
    await expect(result).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, null, {}, { kind: 'file' }, 'unknown', 5])(
    'неизвестное сообщение %j закрывает процесс с null',
    async (value) => {
      const child = new FakeChild();
      const result = new PathProbe(() => child.transport).inspect(path);
      child.emit('message', value);
      await expect(result).resolves.toBeNull();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['exit', 'error'] as const)(
    'событие %s завершает запрос без ожидания тайм-аута',
    async (event) => {
      const child = new FakeChild();
      const result = new PathProbe(() => child.transport).inspect(path);
      child.emit(event, event === 'error' ? new Error('worker fixture failure') : 1);
      await expect(result).resolves.toBeNull();
      expect(child.kill).toHaveBeenCalledTimes(event === 'exit' ? 0 : 1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('не держит больше двух процессов и освобождает место только после подтверждённого exit', async () => {
    const children: FakeChild[] = [];
    const factory = vi.fn(() => {
      const child = new FakeChild();
      children.push(child);
      return child.transport;
    });
    const probe = new PathProbe(factory);
    const first = probe.inspect(path);
    const second = probe.inspect(path);
    await expect(probe.inspect(path)).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    const firstChild = children[0],
      secondChild = children[1];
    if (!firstChild || !secondChild) throw new Error('Ожидались два процесса');
    firstChild.emit('message', 'file');
    await expect(first).resolves.toBe('file');
    // Полученный результат и успешный kill ещё не доказывают завершение ОС-процесса.
    await expect(probe.inspect(path)).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    firstChild.emit('exit', 0);
    const next = probe.inspect(path);
    expect(factory).toHaveBeenCalledTimes(3);
    const nextChild = children[2];
    if (!nextChild) throw new Error('Место не освободилось');
    secondChild.emit('message', 'directory');
    nextChild.emit('message', null);
    await expect(Promise.all([second, next])).resolves.toEqual(['directory', null]);
    for (const child of children) expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ошибка создания процесса не оставляет таймер и занятый слот', async () => {
    const child = new FakeChild();
    const factory = vi
      .fn<() => Transport>()
      .mockImplementationOnce(() => {
        throw new Error('spawn fixture failure');
      })
      .mockReturnValue(child.transport);
    const probe = new PathProbe(factory);
    await expect(probe.inspect(path)).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const next = probe.inspect(path);
    child.emit('message', 'file');
    await expect(next).resolves.toBe('file');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('ошибка отправки запроса закрывает уже созданный процесс', async () => {
    const child = new FakeChild();
    child.postMessage.mockImplementation(() => {
      throw new Error('post fixture failure');
    });
    await expect(new PathProbe(() => child.transport).inspect(path)).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancelAll закрывает ожидания, а новые процессы разрешены только после exit прежних', async () => {
    const children: FakeChild[] = [];
    const probe = new PathProbe(() => {
      const child = new FakeChild();
      children.push(child);
      return child.transport;
    });
    const first = probe.inspect(path),
      second = probe.inspect(path);
    probe.cancelAll();
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
    await expect(probe.inspect(path)).resolves.toBeNull();
    expect(children).toHaveLength(2);
    for (const child of children) {
      // Пока exit не подтверждён, cancelAll повторяет попытку остановки.
      expect(child.kill).toHaveBeenCalledTimes(2);
      child.emit('message', 'file');
      child.emit('exit', 0);
    }
    const next = probe.inspect(path);
    const last = children[2];
    if (!last) throw new Error('Проверка после cancelAll не началась');
    last.emit('message', 'directory');
    await expect(next).resolves.toBe('directory');
    expect(last.kill).toHaveBeenCalledTimes(1);
  });

  it('отмена до spawn повторяет неудачный kill после запуска, но ждёт exit для освобождения слота', async () => {
    const children: FakeChild[] = [];
    const spawned = new Set<FakeChild>();
    const factory = vi.fn(() => {
      const child = new FakeChild();
      child.kill.mockImplementation(() => spawned.has(child));
      children.push(child);
      return child.transport;
    });
    const probe = new PathProbe(factory);
    const first = probe.inspect(path),
      second = probe.inspect(path);
    probe.cancelAll();
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    const firstChild = children[0];
    if (!firstChild) throw new Error('Ожидался первый процесс');
    expect(firstChild.kill).toHaveBeenCalled();
    expect(
      firstChild.kill.mock.results.every(
        (result) => result.type === 'return' && result.value === false,
      ),
    ).toBe(true);
    const previousAttempts = firstChild.kill.mock.calls.length;
    spawned.add(firstChild);
    firstChild.emit('spawn');
    expect(firstChild.kill.mock.calls.length).toBe(previousAttempts + 1);
    expect(firstChild.kill.mock.results.at(-1)?.value).toBe(true);
    await expect(probe.inspect(path)).resolves.toBeNull();
    expect(factory).toHaveBeenCalledTimes(2);
    firstChild.emit('exit', 0);
    const next = probe.inspect(path);
    expect(factory).toHaveBeenCalledTimes(3);
    const nextChild = children[2];
    if (!nextChild) throw new Error('Слот не освободился после exit');
    spawned.add(nextChild);
    nextChild.emit('spawn');
    nextChild.emit('message', 'file');
    await expect(next).resolves.toBe('file');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['false', 'throw'] as const)(
    'kill %s завершает Promise, но без exit удерживает слот и не позволяет третий процесс',
    async (failure) => {
      const children: FakeChild[] = [];
      const factory = vi.fn(() => {
        const child = new FakeChild();
        child.kill.mockImplementation(() => {
          if (failure === 'throw') throw new Error('kill fixture failure');
          return false;
        });
        children.push(child);
        return child.transport;
      });
      const probe = new PathProbe(factory);
      const first = probe.inspect(path);
      const second = probe.inspect(path);
      const firstChild = children[0],
        secondChild = children[1];
      if (!firstChild || !secondChild) throw new Error('Ожидались два процесса');
      firstChild.emit('message', 'file');
      secondChild.emit('message', 'directory');
      await expect(Promise.all([first, second])).resolves.toEqual(['file', 'directory']);
      expect(vi.getTimerCount()).toBe(0);
      await expect(probe.inspect(path)).resolves.toBeNull();
      expect(factory).toHaveBeenCalledTimes(2);
      expect(firstChild.kill).toHaveBeenCalledTimes(1);
      expect(secondChild.kill).toHaveBeenCalledTimes(1);
      firstChild.emit('exit', 0);
      const next = probe.inspect(path);
      expect(factory).toHaveBeenCalledTimes(3);
      const nextChild = children[2];
      if (!nextChild) throw new Error('Слот не освободился после exit');
      nextChild.emit('message', 'file');
      await expect(next).resolves.toBe('file');
    },
  );

  it('обычный транспорт запускает только statWorker с закрытым stdio', async () => {
    const child = new FakeChild();
    forkMock.mockReturnValue(child.transport);
    const result = new PathProbe().inspect(path);
    expect(forkMock).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]paths[\\/]statWorker\.js$/),
      [],
      { stdio: 'ignore', serviceName: 'Schema Teams — проверка пути', partition: 'path-stat' },
    );
    child.emit('message', 'file');
    await expect(result).resolves.toBe('file');
  });
});
