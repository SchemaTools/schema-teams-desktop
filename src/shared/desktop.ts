import type {
  ApiResult,
  ChatDetail,
  ChatList,
  ChatMessage,
  ChatSummary,
  FocusState,
  MessagePage,
  NotificationItem,
  SafeUser,
} from './client';

export interface ClientSnapshot {
  connection:
    | 'connecting'
    | 'online'
    | 'offline'
    | 'signedOut'
    | 'passwordChange'
    | 'incompatible'
    | 'noServer';
  user: SafeUser | null;
  serverVersion: string;
  appVersion: string;
  epoch: number;
  revision: number;
  theme: 'light' | 'dark';
  themePreference: 'system' | 'light' | 'dark';
  chats: ChatSummary[];
  unread: number;
  notifications: NotificationItem[];
  notificationUnread: number;
  focus: FocusState;
  error: string | null;
  navigateChat?: { chatId: number; messageId?: number; nonce: number } | null;
  navigateEvents?: number;
}
export type DesktopRequest =
  | { kind: 'init' | 'login' | 'retry' | 'window.hide' | 'app.quit' }
  | { kind: 'theme'; mode: 'system' | 'light' | 'dark' }
  | ({ epoch: number } & (
      | { kind: 'logout' }
      | { kind: 'window.show'; target?: 'events'; chatId?: number; messageId?: number }
      | { kind: 'chat.list' }
      | { kind: 'chat.detail'; chatId: number }
      | { kind: 'chat.messages'; chatId: number; before?: number; after?: number; around?: number }
      | { kind: 'chat.send'; chatId: number; text: string; requestId: string }
      | { kind: 'chat.read'; chatId: number; upTo: number }
      | { kind: 'chat.view'; chatId: number | null }
      | { kind: 'open.site'; path: string }
      | { kind: 'open.link'; url: string }
      | { kind: 'open.path'; path: string; reveal: boolean }
      | { kind: 'focus.set'; minutes: 0 | 30 | 60 | 480 }
      | { kind: 'notifications.read'; id: number | 'all' }
    ));
export interface DesktopResponseMap {
  init: ClientSnapshot;
  login: null;
  retry: null;
  logout: null;
  theme: null;
  'window.show': null;
  'window.hide': null;
  'app.quit': null;
  'chat.list': ChatList;
  'chat.detail': ChatDetail;
  'chat.messages': MessagePage;
  'chat.send': ChatMessage;
  'chat.read': null;
  'chat.view': null;
  'open.site': null;
  'open.link': null;
  'open.path': 'ok' | 'blocked' | 'unavailable';
  'focus.set': null;
  'notifications.read': null;
}
export interface DesktopBridge {
  request<R extends DesktopRequest>(request: R): Promise<ApiResult<DesktopResponseMap[R['kind']]>>;
  subscribe(listener: (snapshot: ClientSnapshot) => void): () => void;
}
declare global {
  interface Window {
    teams: DesktopBridge;
  }
}
