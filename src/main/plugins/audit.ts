import { pluginCode, pluginVersion } from '../../shared/plugins';
import { positiveId } from '../../shared/time';
export interface PluginAudit {
  operation: 'catalog' | 'download';
  phase: 'requested' | 'result';
  outcome?: 'ok' | 'rejected';
  reason?: string;
  plugin?: string;
  version?: string;
  buildId?: number;
}
export type PluginAuditListener = (event: PluginAudit) => void;
const reasons = new Set([
  'network',
  'timeout',
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_data',
  'stale_session',
  'password_change_required',
  'invalid_plugin',
  'download_aborted',
  'download_http',
  'plugin_unavailable',
  'download_size',
  'download_empty',
  'download_overflow',
  'download_write',
  'download_hash',
]);
/** Diagnostic observer is advisory; only fixed classification and validated identifiers escape. */
export function auditPlugin(listener: PluginAuditListener | undefined, event: PluginAudit): void {
  if (!listener) return;
  if (
    !['catalog', 'download'].includes(event.operation) ||
    !['requested', 'result'].includes(event.phase)
  )
    return;
  const projected: PluginAudit = {
    operation: event.operation,
    phase: event.phase,
    ...((event.outcome === 'ok' || event.outcome === 'rejected') && { outcome: event.outcome }),
    ...(event.reason && { reason: reasons.has(event.reason) ? event.reason : 'error' }),
    ...(pluginCode(event.plugin) && { plugin: event.plugin }),
    ...(pluginVersion(event.version) && { version: event.version }),
    ...(positiveId(event.buildId) && { buildId: event.buildId }),
  };
  try {
    listener(projected);
  } catch {
    /* Logging never changes a network/filesystem outcome. */
  }
}
