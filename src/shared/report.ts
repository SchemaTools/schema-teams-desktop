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
