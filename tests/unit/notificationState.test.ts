import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

type HelperCallback = (error: Error | null, stdout: string) => void;
interface HelperOptions {
  shell: boolean;
  windowsHide: boolean;
  timeout: number;
  maxBuffer: number;
}
const { execFileMock, appMock } = vi.hoisted(() => ({
  execFileMock:
    vi.fn<
      (file: string, args: string[], options: HelperOptions, callback: HelperCallback) => void
    >(),
  appMock: { isPackaged: false, getAppPath: vi.fn(() => 'C:/fixture-app') },
}));
vi.mock('electron', () => ({ app: appMock }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { WindowsNotificationPolicy } from '../../src/main/desktop/notificationState';

const accepted = '{"v":1,"shell":5,"focus":0}';
function answerWith(stdout: string): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null, stdout));
}

beforeEach(() => {
  execFileMock.mockReset();
  appMock.isPackaged = false;
  appMock.getAppPath.mockReturnValue('C:/fixture-app');
});

describe('WindowsNotificationPolicy с настоящим парсером и mocked helper', () => {
  it('два одновременных вызова делят один выполняющийся процесс', async () => {
    let finish: HelperCallback | undefined;
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      finish = callback;
    });
    const policy = new WindowsNotificationPolicy('win32');
    const first = policy.allows();
    const second = policy.allows();
    expect(first).toBe(second);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    if (!finish) throw new Error('Helper не был вызван');
    finish(null, accepted);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it('после завершённого разрешения заново проверяет Focus Assist и замечает включение', async () => {
    answerWith(accepted);
    const policy = new WindowsNotificationPolicy('win32');
    await expect(policy.allows()).resolves.toBe(true);
    answerWith('{"v":1,"shell":5,"focus":2}');
    await expect(policy.allows()).resolves.toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    Object.assign(new Error('helper unavailable'), { code: 'ENOENT' }),
    Object.assign(new Error('helper timed out'), { code: 'ETIMEDOUT', killed: true }),
  ])(
    'ошибка процесса или тайм-аут запрещают показ даже с разрешающим stdout: %j',
    async (error) => {
      execFileMock.mockImplementation((_file, _args, _options, callback) =>
        callback(error, accepted),
      );
      await expect(new WindowsNotificationPolicy('win32').allows()).resolves.toBe(false);
    },
  );

  it.each(['5', 'malformed', '{"v":1,"shell":5}', '{"v":1,"shell":5,"focus":3}'])(
    'не принимает старый или негодный stdout: %s',
    async (stdout) => {
      answerWith(stdout);
      await expect(new WindowsNotificationPolicy('win32').allows()).resolves.toBe(false);
    },
  );

  it('синхронная ошибка запуска не отклоняет allows и не мешает следующей проверке', async () => {
    execFileMock.mockImplementation(() => {
      throw new Error('spawn failure fixture');
    });
    const policy = new WindowsNotificationPolicy('win32');
    await expect(policy.allows()).resolves.toBe(false);
    answerWith(accepted);
    await expect(policy.allows()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('запускает только собственный helper с фиксированными ограничениями и без shell', async () => {
    answerWith(accepted);
    await expect(new WindowsNotificationPolicy('win32').allows()).resolves.toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      join('C:/fixture-app', 'dist/native/notification-state.exe'),
      [],
      { shell: false, windowsHide: true, timeout: 1500, maxBuffer: 128 },
      expect.any(Function),
    );
  });

  it('в установленной сборке берёт helper из app.asar.unpacked', async () => {
    appMock.isPackaged = true;
    appMock.getAppPath.mockReturnValue('C:/fixture-app/resources/app.asar');
    answerWith(accepted);
    await expect(new WindowsNotificationPolicy('win32').allows()).resolves.toBe(true);
    expect(execFileMock.mock.calls[0]?.[0]).toBe(
      join('C:/fixture-app/resources/app.asar.unpacked', 'dist/native/notification-state.exe'),
    );
  });

  it('неизвестная платформа запрещает показ и не запускает helper', async () => {
    await expect(new WindowsNotificationPolicy('linux').allows()).resolves.toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
