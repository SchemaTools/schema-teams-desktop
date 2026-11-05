// Локальное представление; серверный договор находится в bridge/protocol.ts.
/** Лимит текста API отправки (POST /api/chats/:id/messages): быстрый ответ не длиннее. */
export const REPLY_LIMIT = 4000;
export interface ToastSpec {
  key: string;
  delayMs: number;
  id: string;
  groupId: string;
  header?: string;
  title: string;
  body: string;
  hasReply: boolean;
  buttons: string[];
}
