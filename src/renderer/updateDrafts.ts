interface Draft {
  value: string;
  files: readonly unknown[];
  reply?: unknown;
  uploading: boolean;
  pending: boolean;
  uncertain: boolean;
  intent?: unknown;
}
/** All chats, including hidden ones. Unknown delivery is not a discardable draft. */
export function updateDraftFacts(drafts: Readonly<Record<number, Draft>>, editorsOpen: number) {
  const all = Object.values(drafts);
  return {
    dirtyCount: all.filter((d) => d.value.length > 0 || d.files.length > 0 || d.reply != null)
      .length,
    busy: all.some((d) => d.uploading || d.pending || d.uncertain || d.intent != null),
    editorsOpen,
  };
}
