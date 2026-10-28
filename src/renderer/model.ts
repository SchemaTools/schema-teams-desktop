import type { ChatMessage, ChatSummary } from '../shared/client';
import { R } from './strings';

export type Folder = 'all' | 'objects' | 'personal' | 'events';
export type Selection = number | 'events' | null;

export function chatTitle(chat: ChatSummary): string {
  return chat.title || chat.peer?.shortName || R.chat;
}
export function initials(name: string): string {
  return name
    .trim()
    .split(/[\s·]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => [...part][0] ?? '')
    .join('')
    .toLocaleUpperCase('ru-RU');
}
export function colorClass(id: number): string {
  return `color-${Math.abs(id) % 6}`;
}
export function timeLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}
export function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}
export function rowDate(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString() === new Date().toLocaleDateString()
    ? timeLabel(value)
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
export function filteredChats(chats: ChatSummary[], folder: Folder, search: string): ChatSummary[] {
  const needle = search.trim().toLocaleLowerCase('ru-RU');
  return chats.filter(
    (chat) =>
      (folder !== 'objects' || chat.kind === 'object') &&
      (folder !== 'personal' || chat.kind === 'direct') &&
      (!needle || chatTitle(chat).toLocaleLowerCase('ru-RU').includes(needle)),
  );
}
export function needsReply(chat: ChatSummary): boolean {
  return chat.unread > 0 && (chat.kind === 'direct' || chat.mentioned);
}
export function mergeMessages(previous: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const messages = new Map(previous.map((message) => [message.id, message]));
  for (const message of incoming) messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.id - b.id);
}
export function chatLink(link: string | null): { chatId: number; messageId?: number } | null {
  if (!link) return null;
  const match = /^\/chat\/(\d+)(?:\?m=(\d+))?$/.exec(link);
  if (!match) return null;
  const chatId = Number(match[1]);
  const messageId = match[2] ? Number(match[2]) : undefined;
  if (
    !Number.isSafeInteger(chatId) ||
    chatId <= 0 ||
    (messageId !== undefined && (!Number.isSafeInteger(messageId) || messageId <= 0))
  )
    return null;
  return { chatId, ...(messageId !== undefined ? { messageId } : {}) };
}
