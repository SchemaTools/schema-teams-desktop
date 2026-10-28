import type { ApiResult } from '../shared/client';
import type { DesktopRequest, DesktopResponseMap } from '../shared/desktop';
import { R } from './strings';

export async function request<T extends DesktopRequest>(
  action: T,
): Promise<ApiResult<DesktopResponseMap[T['kind']]>> {
  try {
    return await window.teams.request(action);
  } catch {
    return { ok: false, code: 'unavailable', error: R.genericError, retryable: false };
  }
}
