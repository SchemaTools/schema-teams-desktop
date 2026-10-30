export interface ServerConfiguration {
  url: string;
  locked: boolean;
  minimumVersion: string;
  notice: string | null;
}
export interface ServerCheck {
  url: string;
  version: string;
  token: string;
}
/** The native client uses chat API introduced in 0.11, beyond the original wizard minimum. */
export const MINIMUM_SERVER_VERSION = '0.11.0';
export function supportedServerVersion(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9.+-]+)?$/.exec(version);
  return Boolean(parts && (Number(parts[1]) > 0 || Number(parts[2]) >= 11));
}
export function configuredServer(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length > 2048 || /[\\\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value.trim());
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}
export const serverPartitionValid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^persist:teams-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
