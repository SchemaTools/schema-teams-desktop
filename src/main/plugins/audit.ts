import { pluginCode, pluginVersion } from '../../shared/plugins';
import { positiveId } from '../../shared/time';
export interface PluginAudit {
  operation: 'catalog' | 'download' | 'install' | 'rollback' | 'recovery';
  phase: 'requested' | 'result' | 'waiting';
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
  'plugin_trust_unconfigured',
  'plugin_context_unavailable',
  'plugin_job_failed',
  'plugin_recovery_required',
  'plugin_state_unavailable',
  'desktop_update_in_progress',
  'revit_busy',
  'revit_unknown',
  'stale_scope',
  'busy',
  'unfinished_transaction',
  'automatic_admission_changed',
]);
/** Diagnostic observer is advisory; only fixed classification and validated identifiers escape. */
export function auditPlugin(listener: PluginAuditListener | undefined, event: PluginAudit): void {
  if (!listener) return;
  if (
    !['catalog', 'download', 'install', 'rollback', 'recovery'].includes(event.operation) ||
    !['requested', 'result', 'waiting'].includes(event.phase)
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
