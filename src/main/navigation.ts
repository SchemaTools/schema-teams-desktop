// Правила переходов главного окна (ТЗ, 2.4): внутри окна — только адрес сервера,
// остальное — во внешний браузер и только http/https.

/** Разбирает адрес сервера из настроек; возвращает URL или null, если адрес негодный. */
export function parseServerUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  return u;
}

export function isServerUrl(url: string, server: URL): boolean {
  try {
    return new URL(url).origin === server.origin;
  } catch {
    return false;
  }
}

/** Можно ли отдать ссылку внешнему браузеру. */
export function isExternalAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export type NavigationDecision = 'allow' | 'external' | 'deny';

export function decideNavigation(url: string, server: URL): NavigationDecision {
  if (isServerUrl(url, server)) return 'allow';
  return isExternalAllowed(url) ? 'external' : 'deny';
}
