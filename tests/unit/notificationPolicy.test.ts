import { describe, expect, it } from 'vitest';
import {
  notificationStateAllowed,
  parseNotificationState,
} from '../../src/main/desktop/notificationPolicy';

describe('системная политика собственных уведомлений', () => {
  it('разрешает только Windows accepts и выключенный Focus Assist', () => {
    for (const shell of [1, 2, 3, 4, 5, 6, 7]) {
      for (const focus of [0, 1, 2]) {
        const state = parseNotificationState(JSON.stringify({ v: 1, shell, focus }));
        expect(state).toEqual({ v: 1, shell, focus });
        expect(notificationStateAllowed(state)).toBe(shell === 5 && focus === 0);
      }
    }
  });

  it.each([
    '',
    '5',
    'null',
    'true',
    '[]',
    '{}',
    '{',
    '{"v":2,"shell":5,"focus":0}',
    '{"v":"1","shell":5,"focus":0}',
    '{"shell":5,"focus":0}',
    '{"v":1,"shell":5}',
    '{"v":1,"focus":0}',
    '{"v":1,"shell":"5","focus":0}',
    '{"v":1,"shell":true,"focus":0}',
    '{"v":1,"shell":null,"focus":0}',
    '{"v":1,"shell":0,"focus":0}',
    '{"v":1,"shell":8,"focus":0}',
    '{"v":1,"shell":5.1,"focus":0}',
    '{"v":1,"shell":5,"focus":"0"}',
    '{"v":1,"shell":5,"focus":false}',
    '{"v":1,"shell":5,"focus":null}',
    '{"v":1,"shell":5,"focus":-1}',
    '{"v":1,"shell":5,"focus":3}',
    '{"v":1,"shell":5,"focus":0.1}',
    '{"v":1,"shell":5,"focus":0,"unknown":true}',
    '{"v":1,"shell":5,"focus":0}\n5',
    ' '.repeat(257),
  ])('неизвестный или ошибочный ответ не разрешает показ: %j', (stdout) => {
    const state = parseNotificationState(stdout);
    expect(state).toBeNull();
    expect(notificationStateAllowed(state)).toBe(false);
  });

  it('допускает обычные пробелы и перевод строки stdout', () => {
    expect(parseNotificationState(' \r\n {"v":1,"shell":5,"focus":0}\r\n')).toEqual({
      v: 1,
      shell: 5,
      focus: 0,
    });
  });
});
