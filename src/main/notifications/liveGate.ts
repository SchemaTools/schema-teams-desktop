import type { ChatSummary, NotificationItem } from '../../shared/client';

/**
 * History/reconnect establish a watermark, never a source of popup events.
 *
 * Множества виденных ID ограничены: при переполнении вытесняется самый старый ID,
 * а порог его чата (или уведомлений) поднимается до него. Вытесненный ID не всплывёт
 * повторно, а новое уведомление после переполнения не теряется (ревью PR #6).
 */
export class LiveNoticeGate {
  private ready = false;
  private messages = new Map<number, number>();
  private notificationId = 0;
  private seenMessages = new Set<string>();
  private seenNotifications = new Set<number>();
  constructor(private readonly limit = 4096) {}
  reconnect(): void {
    this.ready = false;
  }
  reset(): void {
    this.ready = false;
    this.messages.clear();
    this.notificationId = 0;
    this.seenMessages.clear();
    this.seenNotifications.clear();
  }
  prime(chats: ChatSummary[], notifications: NotificationItem[]): void {
    if (this.ready) return;
    for (const chat of chats)
      if (chat.last)
        this.messages.set(chat.id, Math.max(chat.last.id, this.messages.get(chat.id) ?? 0));
    for (const item of notifications) this.notificationId = Math.max(item.id, this.notificationId);
    for (const key of this.seenMessages) {
      const [chatId, id] = key.split(':');
      if (Number(id) <= (this.messages.get(Number(chatId)) ?? 0)) this.seenMessages.delete(key);
    }
    for (const id of this.seenNotifications)
      if (id <= this.notificationId) this.seenNotifications.delete(id);
    this.ready = true;
  }
  message(chatId: number, id: number): boolean {
    if (id <= (this.messages.get(chatId) ?? 0)) return false;
    const key = `${chatId}:${id}`;
    if (this.seenMessages.has(key)) return false;
    while (this.seenMessages.size >= this.limit) {
      const oldest = this.seenMessages.values().next().value as string;
      this.seenMessages.delete(oldest);
      const [oldChat = 0, oldId = 0] = oldest.split(':').map(Number);
      this.messages.set(oldChat, Math.max(oldId, this.messages.get(oldChat) ?? 0));
    }
    this.seenMessages.add(key);
    return this.ready && id > (this.messages.get(chatId) ?? 0);
  }
  notification(id: number): boolean {
    if (id <= this.notificationId || this.seenNotifications.has(id)) return false;
    while (this.seenNotifications.size >= this.limit) {
      const oldest = this.seenNotifications.values().next().value as number;
      this.seenNotifications.delete(oldest);
      this.notificationId = Math.max(oldest, this.notificationId);
    }
    this.seenNotifications.add(id);
    return this.ready && id > this.notificationId;
  }
}
