import type {
  ApiResult,
  ChatDetail,
  ChatFile,
  ChatReaction,
  ChatList,
  ChatMessage,
  ChatSummary,
  FocusState,
  FilePickResult,
  MessagePage,
  NotificationItem,
  SafeUser,
  ObjectInfo,
} from './client';
import type { TimeOptions, WorkTimer, TimerExpected, TimerPrepared, TimerRow } from './time';
import type { LocalPreferences, PreferencesPatch, PreferencesTab } from './preferences';
import type { UpdateState } from './updates';
import type { ServerConfiguration, ServerCheck } from './serverConfiguration';

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
  historyRevision?: number;
  typing?: { chatId: number; userId: number; shortName: string; until: number }[];
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
  timer?: WorkTimer | null;
  timerReady?: boolean;
  timerError?: string | null;
  timerObservedAt?: number;
  recentTimeTaskIds?: number[];
  timerAbsence?: { id: number; from: number; to: number } | null;
  timerReminderTime?: string;
  navigateTimer?: { mode: 'pick' | 'finish'; taskId?: number; nonce: number } | null;
  preferences?: LocalPreferences;
  navigateSettings?: { tab: PreferencesTab; nonce: number } | null;
  updates?: UpdateState;
}
export type DesktopRequest =
  | { kind: 'init' | 'login' | 'retry' | 'window.hide' | 'app.quit' }
  | { kind: 'theme'; mode: 'system' | 'light' | 'dark' }
  | { kind: 'settings.read' | 'logs.open' }
  | { kind: 'settings.open'; tab: PreferencesTab }
  | { kind: 'settings.patch'; patch: PreferencesPatch }
  | { kind: 'updates.check' }
  | { kind: 'updates.later'; version: string }
  | { kind: 'server.read' }
  | { kind: 'server.check'; url: string }
  | { kind: 'server.apply'; url: string; token: string }
  | ({ epoch: number } & (
      | { kind: 'logout' }
      | { kind: 'timer.read' | 'timer.options' }
      | { kind: 'timer.open'; mode: 'pick' | 'finish'; taskId?: number }
      | { kind: 'timer.absenceDismiss'; id: number }
      | { kind: 'timer.preferences'; reminderTime: string }
      | { kind: 'timer.start'; taskId: number; expected: TimerExpected | null }
      | { kind: 'timer.pause'; expected: TimerExpected }
      | { kind: 'timer.resume'; expected: TimerExpected }
      | { kind: 'timer.reset'; expected: TimerExpected }
      | { kind: 'timer.proposal'; expected: TimerExpected }
      | { kind: 'timer.finish'; expected: TimerExpected; rows: TimerRow[]; note: string }
      | { kind: 'window.show'; target?: 'events'; chatId?: number; messageId?: number }
      | { kind: 'chat.list' }
      | { kind: 'chat.detail'; chatId: number }
      | { kind: 'chat.objectInfo'; chatId: number }
      | { kind: 'chat.search'; chatId: number; q: string }
      | { kind: 'chat.markRead'; chatId: number }
      | { kind: 'chat.messages'; chatId: number; before?: number; after?: number; around?: number }
      | {
          kind: 'chat.send';
          chatId: number;
          text: string;
          requestId: string;
          fileIds?: number[];
          replyTo?: number;
        }
      | { kind: 'chat.edit'; chatId: number; messageId: number; text: string }
      | { kind: 'chat.delete'; chatId: number; messageId: number }
      | { kind: 'chat.pin'; chatId: number; messageId: number | null }
      | {
          kind: 'chat.reaction';
          chatId: number;
          messageId: number;
          reaction: string;
          remove: boolean;
        }
      | { kind: 'chat.read'; chatId: number; upTo: number }
      | { kind: 'chat.typing'; chatId: number }
      | { kind: 'chat.view'; chatId: number | null }
      | { kind: 'open.site'; path: string }
      | { kind: 'open.link'; url: string }
      | { kind: 'open.path'; path: string; reveal: boolean }
      | { kind: 'file.preview'; chatId: number; messageId: number; fileId: number }
      | { kind: 'file.pick'; chatId: number; limit: number }
      | { kind: 'file.paste'; chatId: number }
      | {
          kind: 'file.action';
          chatId: number;
          messageId: number;
          fileId: number;
          action: 'save' | 'open' | 'reveal';
        }
      | { kind: 'focus.set'; minutes: 0 | 30 | 60 | 480 }
      | { kind: 'notifications.read'; id: number | 'all' }
    ));
export interface DesktopResponseMap {
  init: ClientSnapshot;
  login: null;
  retry: null;
  logout: null;
  'timer.read': WorkTimer | null;
  'timer.options': TimeOptions;
  'timer.open': null;
  'timer.absenceDismiss': null;
  'timer.preferences': null;
  'timer.start': WorkTimer | null;
  'timer.pause': WorkTimer | null;
  'timer.resume': WorkTimer | null;
  'timer.reset': WorkTimer | null;
  'timer.proposal': TimerPrepared;
  'timer.finish': WorkTimer | null;
  theme: null;
  'settings.read': LocalPreferences;
  'settings.open': null;
  'settings.patch': LocalPreferences;
  'logs.open': null;
  'updates.check': UpdateState;
  'updates.later': null;
  'server.read': ServerConfiguration;
  'server.check': ServerCheck;
  'server.apply': null;
  'window.show': null;
  'window.hide': null;
  'app.quit': null;
  'chat.list': ChatList;
  'chat.detail': ChatDetail;
  'chat.objectInfo': ObjectInfo;
  'chat.search': ChatMessage[];
  'chat.markRead': null;
  'chat.messages': MessagePage;
  'chat.send': ChatMessage;
  'chat.edit': ChatMessage;
  'chat.delete': ChatMessage;
  'chat.pin': null;
  'chat.reaction': ChatReaction[];
  'chat.read': null;
  'chat.typing': null;
  'chat.view': null;
  'open.site': null;
  'open.link': null;
  'open.path': 'ok' | 'blocked' | 'unavailable';
  'file.preview': { url: string };
  'file.pick': FilePickResult;
  'file.paste': ChatFile | null;
  'file.action': 'saved' | 'opened' | 'revealed' | 'canceled' | 'blocked';
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
