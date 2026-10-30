import type { ChatSummary, NotificationItem } from '../../shared/client';

/** History/reconnect establish a watermark, never a source of popup events. */
export class LiveNoticeGate {
  private ready = false;
  private messages = new Map<number, number>();
  private notificationId = 0;
  private seenMessages = new Set<string>();
  private seenNotifications = new Set<number>();
  private saturated = false;
  private overflowMessages = new Map<number, number>();
  private overflowNotification = 0;
  private overflowUnbounded = false;
  constructor(private readonly limit = 4096) {}
  private remember<T>(seen: Set<T>, key: T): boolean {
    if (seen.has(key)) return false;
    if (seen.size >= this.limit) {
      this.saturated = true;
      this.ready = false;
      return false;
    }
    seen.add(key);
    return true;
  }
  reconnect(): void {
    this.ready = false;
  }
  reset(): void {
    this.ready = false;
    this.messages.clear();
    this.notificationId = 0;
    this.seenMessages.clear();
    this.seenNotifications.clear();
    this.saturated = false;
    this.overflowMessages.clear();
    this.overflowNotification = 0;
    this.overflowUnbounded = false;
  }
  prime(chats: ChatSummary[], notifications: NotificationItem[], freshSnapshot = false): void {
    if (this.ready) return;
    if (this.saturated && !freshSnapshot) return;
    for (const chat of chats)
      if (chat.last)
        this.messages.set(chat.id, Math.max(chat.last.id, this.messages.get(chat.id) ?? 0));
    for (const item of notifications) this.notificationId = Math.max(item.id, this.notificationId);
    if (this.saturated) {
      // Fresh history must cover every dropped ID before reopening. Keep concurrent
      // live IDs above that history floor; quiet/suppressed IDs cannot revive.
      for (const key of this.seenMessages) {
        const [chatId, id] = key.split(':');
        if (Number(id) <= (this.messages.get(Number(chatId)) ?? 0)) this.seenMessages.delete(key);
      }
      for (const id of this.seenNotifications)
        if (id <= this.notificationId) this.seenNotifications.delete(id);
      for (const [chatId, id] of this.overflowMessages)
        if (id <= (this.messages.get(chatId) ?? 0)) this.overflowMessages.delete(chatId);
      if (
        this.overflowUnbounded ||
        this.overflowMessages.size ||
        this.overflowNotification > this.notificationId ||
        this.seenMessages.size >= this.limit ||
        this.seenNotifications.size >= this.limit
      )
        return;
      this.saturated = false;
      this.overflowNotification = 0;
    }
    this.ready = true;
  }
  message(chatId: number, id: number): boolean {
    if (id <= (this.messages.get(chatId) ?? 0)) return false;
    const fresh = this.remember(this.seenMessages, `${chatId}:${id}`);
    if (this.saturated && !this.seenMessages.has(`${chatId}:${id}`)) {
      if (this.overflowMessages.size >= this.limit && !this.overflowMessages.has(chatId))
        this.overflowUnbounded = true;
      else this.overflowMessages.set(chatId, Math.max(id, this.overflowMessages.get(chatId) ?? 0));
    }
    return this.ready && fresh && id > (this.messages.get(chatId) ?? 0);
  }
  notification(id: number): boolean {
    if (id <= this.notificationId) return false;
    const fresh = this.remember(this.seenNotifications, id);
    if (this.saturated && !this.seenNotifications.has(id))
      this.overflowNotification = Math.max(id, this.overflowNotification);
    return fresh && this.ready && id > this.notificationId;
  }
}
