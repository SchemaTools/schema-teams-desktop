import { describe, expect, it, vi } from 'vitest';

// Окно Electron здесь не создаётся: проверяется только правило вызова bootstrap.
vi.mock('electron', () => ({ BrowserWindow: vi.fn() }));
import {
  LOGIN_PAGE_RECHECK_MS,
  LOGIN_RECHECK_MS,
  LoginReadiness,
} from '../../src/main/loginWindow';

const server = new URL('http://server.test:8080/');
function readiness() {
  let now = 0;
  const r = new LoginReadiness(server, () => now);
  return { r, advance: (ms: number) => (now += ms) };
}

describe('LoginReadiness', () => {
  it('на странице входа опрос раз в 2 с не зовёт bootstrap, только редкий повтор', () => {
    const { r, advance } = readiness();
    const login = 'http://server.test:8080/login';
    // Первая загрузка — одна проверка: cookie могли остаться от прошлого входа.
    expect(r.shouldCheck(login)).toBe(true);
    let calls = 0;
    for (let i = 0; i < 14; i++) {
      advance(2000);
      if (r.shouldCheck(login)) calls++;
    }
    expect(calls).toBe(0);
    advance(LOGIN_PAGE_RECHECK_MS);
    expect(r.shouldCheck(login)).toBe(true);
  });
  it('переход со страницы входа на адрес сервера — сразу, повтор того же адреса — с паузой', () => {
    const { r, advance } = readiness();
    expect(r.shouldCheck('http://server.test:8080/login')).toBe(true);
    advance(500);
    expect(r.shouldCheck('http://server.test:8080/')).toBe(true);
    advance(2000);
    expect(r.shouldCheck('http://server.test:8080/')).toBe(false);
    advance(LOGIN_RECHECK_MS);
    expect(r.shouldCheck('http://server.test:8080/')).toBe(true);
    advance(100);
    expect(r.shouldCheck('http://server.test:8080/chat')).toBe(true);
  });
  it('возврат на страницу входа после проверки не зовёт bootstrap; чужие адреса — никогда', () => {
    const { r, advance } = readiness();
    expect(r.shouldCheck('http://server.test:8080/')).toBe(true);
    advance(100);
    expect(r.shouldCheck('http://server.test:8080/login?next=%2F')).toBe(false);
    expect(r.shouldCheck('https://foreign.test/')).toBe(false);
    expect(r.shouldCheck('not a url')).toBe(false);
  });
});
