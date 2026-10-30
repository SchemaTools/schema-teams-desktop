export interface ReportOptions {
  description: string;
  applicationLogs: boolean;
  revitYear: 2025 | 2026 | null;
  includeScreenshot: boolean;
}
export interface ReportCapture {
  image: string;
  width: number;
  height: number;
}
export interface ReportPreview {
  id: string;
  files: { name: string; size: number; text?: string; image?: string }[];
  notices: string[];
}
export interface ReportExport {
  id: string;
  fileName: string;
}
export interface ReportScreen {
  id: string;
  label: string;
}
export interface SupportReceipt {
  chatId: number;
  messageId: number;
}
export interface SupportPayload {
  text: string;
  fileIds: number[];
}
export interface SupportFileManifest {
  name: string;
  size: number;
  sha256: string;
  fileId: number;
}
export interface SupportAttemptView {
  id: string;
  previewId: string;
  text: string;
  files: { name: string; size: number }[];
  status: 'unresolved' | 'review' | 'confirmed' | 'rejected' | 'resolved';
  retryAllowed: boolean;
  receipt?: SupportReceipt;
}
export interface ReportSupportState {
  available: boolean;
  error: string | null;
  attempt: SupportAttemptView | null;
}
export function supportPayloadValid(v: unknown): v is SupportPayload {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return (
    Object.keys(x).length === 2 &&
    Object.keys(x).every((k) => ['text', 'fileIds'].includes(k)) &&
    typeof x.text === 'string' &&
    x.text === x.text.trim() &&
    x.text.length <= 4000 &&
    Array.isArray(x.fileIds) &&
    x.fileIds.length <= 3 &&
    x.fileIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) &&
    new Set(x.fileIds).size === x.fileIds.length &&
    (x.text.length > 0 || x.fileIds.length > 0)
  );
}
export function reportOptionsValid(raw: unknown): raw is ReportOptions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const x = raw as Record<string, unknown>;
  return (
    Object.keys(x).length === 4 &&
    Object.keys(x).every((k) =>
      ['description', 'applicationLogs', 'revitYear', 'includeScreenshot'].includes(k),
    ) &&
    typeof x.description === 'string' &&
    x.description.trim().length > 0 &&
    x.description.length <= 4000 &&
    Array.from(x.description).every(
      (character) => character.charCodeAt(0) >= 32 || '\r\n\t'.includes(character),
    ) &&
    typeof x.applicationLogs === 'boolean' &&
    typeof x.includeScreenshot === 'boolean' &&
    [null, 2025, 2026].includes(x.revitYear as number | null)
  );
}
