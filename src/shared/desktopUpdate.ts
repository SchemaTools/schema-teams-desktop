export interface DesktopDraftSummary {
  readonly revision: number;
  readonly dirtyCount: number;
  readonly editorsOpen: number;
  readonly busy: boolean;
}
export interface DesktopUpdateView {
  readonly phase:
    | 'idle'
    | 'preparing'
    | 'ready'
    | 'confirming'
    | 'validating'
    | 'handing-off'
    | 'handed-off'
    | 'error';
  readonly offerId: string | null;
  readonly jobId: string | null;
  readonly version: string | null;
  readonly fraction: number;
  readonly challenge: Readonly<{ id: string; revision: number; dirtyCount: number }> | null;
  readonly error: string | null;
}
export interface DesktopUpdateSnapshot extends DesktopUpdateView {
  readonly contextId: string;
  readonly documentId: string;
  readonly installationAvailable: boolean;
}
