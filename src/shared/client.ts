// DTO проецируются из shared сервера 0.11.2 (f176f763). Здесь нет SessionInfo:
// cookie и csrfToken остаются исключительно в главном процессе.
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; error: string; retryable: boolean; uncertain?: boolean };

export interface SafeUser {
  id: number;
  shortName: string;
  mustChangePassword: boolean;
}
export interface Health {
  status: 'ok' | 'error';
  db: 'ok' | 'down';
  version: string;
}
export interface PersonRef {
  id: number;
  shortName: string;
}
export interface ChatSummary {
  id: number;
  kind: 'direct' | 'group' | 'object' | 'bureau';
  title: string;
  peer: PersonRef | null;
  objectId: number | null;
  objectCode: string | null;
  memberCount: number;
  last: {
    id: number;
    authorShortName: string | null;
    authorId: number | null;
    preview: string;
    at: string;
    deleted: boolean;
  } | null;
  unread: number;
  mentioned: boolean;
  photoFileId: number | null;
}
export interface ChatList {
  items: ChatSummary[];
  unreadTotal: number;
}
export interface ChatFile {
  fileId: number;
  fileName: string;
  size: number;
  mime: string;
  isImage: boolean;
}
export interface FilePickResult {
  items: ChatFile[];
  canceled: boolean;
  error?: string;
}
export interface ChatReaction {
  kind: string;
  users: PersonRef[];
}
export interface ChatPoll {
  id: number;
  question: string;
  options: { text: string; votes: number | null; voters: PersonRef[] }[];
  multi: boolean;
  anonymous: boolean;
  closesAt: string | null;
  closed: boolean;
  remind: boolean;
  mine: number[];
  answered: number;
  total: number;
  canManage: boolean;
}
export interface ChatMessage {
  id: number;
  chatId: number;
  author: PersonRef | null;
  text: string;
  at: string;
  editedAt: string | null;
  deleted: boolean;
  replyTo: { id: number; authorShortName: string | null; preview: string; deleted: boolean } | null;
  files: ChatFile[];
  mentions: number[];
  links: { text: string; taskId: number; title: string }[];
  canEdit: boolean;
  reactions: ChatReaction[];
  cards: { type: string; id: number }[];
  sticker: { id: number; fileId: number | null } | null;
  poll: ChatPoll | null;
}
export interface MessagePage {
  items: ChatMessage[];
  hasMore: boolean;
  hasNewer: boolean;
}
export interface ChatDetail {
  chat: ChatSummary;
  members: { user: PersonRef; readUpTo: number | null; photoFileId: number | null }[];
  canManageMembers: boolean;
  canLeave: boolean;
  canWrite: boolean;
  pinned: { id: number; authorShortName: string | null; preview: string } | null;
  canPin: boolean;
  taskStageId: number | null;
}
/** Read-only projection of ObjectDetail; authorization remains on the Teams server. */
export interface ObjectInfo {
  id: number;
  code: string;
  name: string;
  fullName: string | null;
  client: string | null;
  address: string | null;
  status: 'active' | 'paused' | 'archive';
  statusNote: string | null;
  gip: PersonRef | null;
  gap: PersonRef | null;
  pm: PersonRef | null;
  folderRoot: string | null;
  modelPath: string | null;
  currentStageId: number | null;
  stages: {
    id: number;
    code: string;
    name: string;
    startDate: string;
    endDate: string;
    closed: boolean;
  }[];
}
export interface NotificationItem {
  id: number;
  event: string;
  at: string;
  read: boolean;
  author: { id: number; shortName: string; photoFileId: number | null } | null;
  task: {
    id: number;
    kind: string;
    mark: string | null;
    title: string;
    objectName: string | null;
    stageCode: string | null;
  } | null;
  changes: { field: string; from: string | null; to: string | null }[];
  reason: string | null;
  subject: string | null;
  link: string | null;
}
export interface NotificationPage {
  items: NotificationItem[];
  unread: number;
  nextBefore: number | null;
}
export interface FocusState {
  until: string | null;
  startedAt: string | null;
}
/** GET /api/notification-settings; отдельного переключателя обычных сообщений нет. */
export interface NotificationSettings {
  rows: { key: string; inApp: boolean }[];
  digestHourly: boolean;
  quiet: { from: string; to: string } | null;
}
export interface FocusSummary {
  messages: number;
  mentions: number;
  chats: { chatId: number; title: string; count: number; mentions: number; last: string[] }[];
}
