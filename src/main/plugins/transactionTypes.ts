export interface PluginScope {
  serverHash: string;
  ownerId: number;
}
export interface OwnedPluginFile {
  packageKey: string;
  targetPath: string;
  kind: 'dll' | 'addin' | 'data';
  sha256: string;
  size: number;
  addInIds?: string[];
}
export interface InstalledPluginPackage {
  code: string;
  buildId: number;
  version: string;
  archiveSha256: string;
  archiveSize: number;
  revit: (2025 | 2026)[];
  descriptorId: string;
}
export interface PluginReceipt {
  schema: 1;
  id: string;
  scope: PluginScope;
  rootsHash: string;
  files: OwnedPluginFile[];
  packages: InstalledPluginPackage[];
}
export interface StagedPluginFile extends OwnedPluginFile {
  sourceRoot: string;
  sourcePath: string;
}
export interface PluginTransactionPlan {
  id: string;
  scope: PluginScope;
  replace: { code: string; year: 2025 | 2026 }[];
  files: StagedPluginFile[];
  packages: InstalledPluginPackage[];
  expectedCurrentId: string | null;
}
export interface PluginBackupRecord {
  schema: 1;
  backupId: string;
  receipt: PluginReceipt;
  replacedBy: string;
}
export interface PluginBeforeFile {
  targetPath: string;
  sha256: string;
  size: number;
}
export interface PluginTransactionJournal {
  schema: 2;
  id: string;
  rootsHash: string;
  scope: PluginScope;
  purpose: 'install' | 'rollback';
  next: PluginReceipt;
  previous: PluginReceipt | null;
  priorBackup: PluginBackupRecord | null;
  sources: StagedPluginFile[];
  before: PluginBeforeFile[];
  backupFiles: PluginBeforeFile[];
  removals: OwnedPluginFile[];
  removalIntents: string[];
  phase: 'intent' | 'backed-up' | 'payload' | 'addin' | 'metadata' | 'complete';
}
export type PluginTransactionResult =
  | { status: 'complete'; receipt: PluginReceipt }
  | { status: 'waiting' | 'blocked' | 'recovery'; reason: string };
