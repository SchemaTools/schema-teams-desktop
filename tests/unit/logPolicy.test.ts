import { describe, expect, it } from 'vitest';
import { maskErrorMessage, projectLog } from '../../src/main/logPolicy';
import { applicationLog } from '../../src/main/diagnostics/logs';
import { REALTIME_EVENTS } from '../../src/main/realtime/events';
describe('Fixed diagnostic projection', () => {
  it('keeps fixed plugin operation classification on disk and in legacy report projection', () => {
    const event = {
      operation: 'rollback',
      phase: 'result',
      outcome: 'rejected',
      reason: 'revit_busy',
      plugin: 'floor-plans',
      version: '2.0',
      buildId: 42,
      path: 'private path',
      cookie: 'private cookie',
      error: 'private stack',
    };
    const projected = projectLog('плагины', event);
    expect(projected.details).toEqual({
      operation: 'rollback',
      phase: 'result',
      outcome: 'rejected',
      reason: 'revit_busy',
      plugin: 'floor-plans',
      version: '2.0',
      buildId: '42',
    });
    const report = applicationLog(`2026-11-03T00:00:00.000Z INFO плагины ${JSON.stringify(event)}`);
    expect(report).toContain('"operation":"rollback"');
    expect(report).not.toMatch(/private|cookie|path|stack/);
    expect(
      projectLog('плагины', {
        ...event,
        reason: 'private reason',
        plugin: '../private',
        version: 'private',
        buildId: -1,
      }).details,
    ).toEqual({ operation: 'rollback', phase: 'result', outcome: 'rejected', reason: 'error' });
  });
  it('retains only the error class for shutdown cleanup failures', () => {
    expect(
      projectLog('ошибка завершения клиента', {
        err: new TypeError('private shutdown detail'),
        stack: 'private stack',
      }),
    ).toEqual({ message: 'ошибка завершения клиента', details: { errorType: 'TypeError' } });
  });
  it('keeps actual realtime kinds including timer/notification without any payload', () => {
    for (const event of REALTIME_EVENTS)
      expect(
        projectLog('событие клиента', {
          event,
          text: 'private text',
          userId: 12,
          taskId: 42,
          cookie: 'private cookie',
        }),
      ).toEqual({ message: 'событие клиента', details: { event } });
    expect(projectLog('событие клиента', { event: 'private event' }).details).toEqual({});
  });
  it('keeps only fixed command phases/outcomes and maps unknown server codes to other', () => {
    expect(
      projectLog('команда таймера', {
        command: 'finish',
        phase: 'result',
        outcome: 'uncertain',
        code: 'timeout',
        note: 'private note',
        taskId: 55,
        rows: [{}],
      }).details,
    ).toEqual({ command: 'finish', phase: 'result', outcome: 'uncertain', code: 'timeout' });
    expect(
      projectLog('команда таймера', {
        command: 'private',
        phase: 'private',
        outcome: 'private',
        code: 'private response',
      }).details,
    ).toEqual({ code: 'other' });
  });
  it('does not accidentally allow one event metadata on a different message', () => {
    expect(
      projectLog('выход', {
        app: '0.6.5',
        state: 'online',
        command: 'finish',
        event: 'chat:message',
        errorType: 'TypeError',
      }).details,
    ).toEqual({});
    expect(
      projectLog('состояние соединения', { state: 'online', server: 'private address', userId: 12 })
        .details,
    ).toEqual({ state: 'online' });
  });
  it('filters malformed getters, nested objects and supplied JSON serializers', () => {
    const raw = {
      get state() {
        throw Error('private');
      },
      toJSON: () => ({ password: 'private' }),
    };
    expect(projectLog('состояние соединения', raw).details).toEqual({});
    expect(
      projectLog('запуск', {
        app: { version: 'private' },
        chrome: 'x'.repeat(10000),
        windows: 'private',
        packaged: 'true',
      }).details,
    ).toEqual({});
  });
  it('legacy report projection shares the same policy and does not reintroduce raw exception data', () => {
    const text = applicationLog(
      '2026-10-29T23:00:00.000Z INFO команда таймера {"command":"finish","phase":"result","outcome":"uncertain","code":"timeout","note":"private note","taskId":42}\n2026-10-29T23:00:01.000Z INFO состояние соединения {"state":"offline","server":"private address"}\n2026-10-29T23:00:02.000Z ERROR необработанная ошибка {"errorType":"TypeError","message":"private error","stack":"private stack"}',
    );
    expect(text).toContain('"outcome":"uncertain"');
    expect(text).toContain('"state":"offline"');
    expect(text).toContain('"errorType":"TypeError"');
    expect(text).not.toMatch(/private|taskId|message|stack/);
  });
  it('открытие пути: путь UNC и причина сохраняются, негодный путь и прочее — нет', () => {
    const bs = '\x5C';
    const path = `${bs}${bs}server${bs}share${bs}Объект А`;
    expect(
      projectLog('открытие пути', {
        path,
        result: 'blocked',
        reason: 'foreign-host-declined',
        host: 'server',
      }).details,
    ).toEqual({ path, result: 'blocked', reason: 'foreign-host-declined' });
    expect(
      projectLog('открытие пути', { path: 'C:/private/file.rvt', result: 'ok', reason: 'x' })
        .details,
    ).toEqual({ result: 'ok' });
    const report = applicationLog(
      `2026-11-05T00:00:00.000Z INFO открытие пути ${JSON.stringify({ path, result: 'ok' })}`,
    );
    expect(report).toContain(JSON.stringify(path));
  });
  it('ошибка обновления: этап и код update_/download_, остальное — update_failed', () => {
    expect(
      projectLog('ошибка обновления', {
        stage: 'prepare',
        code: 'download_hash',
        file: 'private path',
      }).details,
    ).toEqual({ stage: 'prepare', code: 'download_hash' });
    expect(
      projectLog('ошибка обновления', { stage: 'other', code: 'ENOENT private path' }).details,
    ).toEqual({ code: 'update_failed' });
  });
  it('необработанная ошибка: имя и сообщение с маской профиля и секретов, без стека', () => {
    const bs = '\x5C';
    const err = new TypeError(
      `cannot open C:${bs}Users${bs}Иванов${bs}AppData${bs}x.json st_session=abc123 http://server.test/a?token=1\nnext`,
    );
    const details = projectLog('необработанная ошибка', { err, stack: err.stack }).details;
    expect(details.errorType).toBe('TypeError');
    expect(details.errorMessage).toBe(
      `cannot open C:${bs}Users${bs}<user>${bs}AppData${bs}x.json st_session=<скрыто> http://server.test/a?<скрыто> next`,
    );
    expect(JSON.stringify(details)).not.toMatch(/Иванов|abc123|token=1|at /);
    // Повторная проекция (журнал в «Сообщить о проблеме») ничего не меняет.
    expect(projectLog('необработанная ошибка', details).details).toEqual(details);
    expect(maskErrorMessage(String(details.errorMessage))).toBe(details.errorMessage);
    expect(maskErrorMessage('x'.repeat(1000))).toHaveLength(300);
  });
  it('отказ не объектом Error и ошибка завершения — без текста', () => {
    expect(projectLog('необработанный отказ', { err: 'private password' }).details).toEqual({});
    expect(
      projectLog('cookie не сохранены', { err: new Error('private cookie detail') }).details,
    ).toEqual({ errorType: 'Error' });
  });
});

describe('Ревью PR #6: записи о хранилищах паузы и поддержки', () => {
  it('сброс хранилища — только имя хранилища; удаление записей — только число', () => {
    expect(projectLog('хранилище сброшено', { store: 'pause-outbox', path: 'C:/x' })).toEqual({
      message: 'хранилище сброшено',
      details: { store: 'pause-outbox' },
    });
    expect(projectLog('хранилище сброшено', { store: 'другое' }).details).toEqual({});
    expect(projectLog('записи паузы удалены', { count: '3', owner: '7' }).details).toEqual({
      count: '3',
    });
    expect(projectLog('записи паузы удалены', { count: 'много' }).details).toEqual({});
    expect(projectLog('не удалось сохранить недавние задачи').message).toBe(
      'не удалось сохранить недавние задачи',
    );
    expect(projectLog('не удалось сохранить таймер этого компьютера').message).toBe(
      'не удалось сохранить таймер этого компьютера',
    );
  });
});
