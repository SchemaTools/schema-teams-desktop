import { describe, expect, it } from 'vitest';
import { projectLog } from '../../src/main/logPolicy';
import { applicationLog } from '../../src/main/diagnostics/logs';
import { REALTIME_EVENTS } from '../../src/main/realtime/events';
describe('Fixed diagnostic projection', () => {
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
});
