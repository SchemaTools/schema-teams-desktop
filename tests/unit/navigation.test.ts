import { describe, expect, it } from 'vitest';
import { decideNavigation, isExternalAllowed, parseServerUrl } from '../../src/main/navigation';

const server = new URL('http://server.test:8080/');

describe('parseServerUrl', () => {
  it('принимает http и https', () => {
    expect(parseServerUrl('http://server.test:8080')?.origin).toBe('http://server.test:8080');
    expect(parseServerUrl(' https://server.test/ ')?.origin).toBe('https://server.test');
  });
  it('отклоняет пустое, мусор, другие схемы и адрес с логином', () => {
    for (const v of [
      undefined,
      '',
      '   ',
      'server.test',
      'file:///C:/x',
      'javascript:alert(1)',
      'http://u:p@example.com/',
    ]) {
      expect(parseServerUrl(v)).toBeNull();
    }
  });
});

describe('decideNavigation', () => {
  it('адрес сервера — в окне', () => {
    expect(decideNavigation('http://server.test:8080/chat/5?m=1', server)).toBe('allow');
  });
  it('другой порт, хост или схема — не сервер', () => {
    expect(decideNavigation('http://server.test:8081/', server)).toBe('external');
    expect(decideNavigation('https://server.test:8080/', server)).toBe('external');
    expect(decideNavigation('http://other.test:8080/', server)).toBe('external');
  });
  it('не http — запрещено', () => {
    for (const u of [
      'file:///C:/Windows',
      'javascript:alert(1)',
      'ms-settings:',
      'data:text/html,x',
      'not a url',
    ]) {
      expect(decideNavigation(u, server)).toBe('deny');
    }
  });
});

describe('isExternalAllowed', () => {
  it('только http и https', () => {
    expect(isExternalAllowed('https://example.com/')).toBe(true);
    expect(isExternalAllowed('mailto:someone@example.com')).toBe(false);
    expect(isExternalAllowed('\\\\server\\share')).toBe(false);
  });
});
