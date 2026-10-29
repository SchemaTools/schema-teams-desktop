import type { DesktopRequest } from './desktop';
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
export function requestValid(raw: unknown): raw is DesktopRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string') return false;
  const scoped = !['init', 'login', 'retry', 'theme', 'window.hide', 'app.quit'].includes(
    String(r.kind),
  );
  if (scoped && (typeof r.epoch !== 'number' || !Number.isSafeInteger(r.epoch) || r.epoch < 0))
    return false;
  const only = (...keys: string[]) =>
    Object.keys(r).every((k) => k === 'kind' || (scoped && k === 'epoch') || keys.includes(k));
  switch (r.kind) {
    case 'init':
    case 'login':
    case 'retry':
    case 'logout':
    case 'window.hide':
    case 'app.quit':
    case 'chat.list':
      return only();
    case 'window.show':
      return (
        only('target', 'chatId', 'messageId') &&
        (r.target === undefined || r.target === 'events') &&
        (r.chatId === undefined || id(r.chatId)) &&
        (r.messageId === undefined || id(r.messageId)) &&
        !(r.target && r.chatId) &&
        !(r.messageId && !r.chatId)
      );
    case 'theme':
      return (
        only('mode') && typeof r.mode === 'string' && ['system', 'light', 'dark'].includes(r.mode)
      );
    case 'chat.detail':
    case 'chat.markRead':
    case 'chat.typing':
      return only('chatId') && id(r.chatId);
    case 'chat.messages':
      return (
        only('chatId', 'before', 'after', 'around') &&
        id(r.chatId) &&
        ['before', 'after', 'around'].filter((k) => r[k] !== undefined).length <= 1 &&
        ['before', 'after', 'around'].every((k) => r[k] === undefined || id(r[k]))
      );
    case 'chat.search':
      return (
        only('chatId', 'q') && id(r.chatId) && text(r.q, 100) && (r.q as string).trim().length >= 2
      );
    case 'chat.send':
      return (
        only('chatId', 'text', 'requestId', 'fileIds', 'replyTo') &&
        id(r.chatId) &&
        (r.replyTo === undefined || id(r.replyTo)) &&
        text(r.text, 4000) &&
        (r.fileIds === undefined ||
          (Array.isArray(r.fileIds) &&
            r.fileIds.length <= 10 &&
            r.fileIds.every(id) &&
            new Set(r.fileIds).size === r.fileIds.length)) &&
        ((r.text as string).trim().length > 0 ||
          (Array.isArray(r.fileIds) && r.fileIds.length > 0)) &&
        typeof r.requestId === 'string' &&
        /^[A-Za-z0-9._:-]{8,100}$/.test(r.requestId)
      );
    case 'chat.edit':
      return (
        only('chatId', 'messageId', 'text') &&
        id(r.chatId) &&
        id(r.messageId) &&
        text(r.text, 4000) &&
        (r.text as string).trim().length > 0
      );
    case 'chat.delete':
      return only('chatId', 'messageId') && id(r.chatId) && id(r.messageId);
    case 'chat.pin':
      return (
        only('chatId', 'messageId') && id(r.chatId) && (r.messageId === null || id(r.messageId))
      );
    case 'chat.reaction':
      return (
        only('chatId', 'messageId', 'reaction', 'remove') &&
        id(r.chatId) &&
        id(r.messageId) &&
        typeof r.reaction === 'string' &&
        ['like', 'done', 'look', 'heart', 'laugh', 'question'].includes(r.reaction) &&
        typeof r.remove === 'boolean'
      );
    case 'file.pick':
      return (
        only('chatId', 'limit') &&
        id(r.chatId) &&
        typeof r.limit === 'number' &&
        Number.isSafeInteger(r.limit) &&
        r.limit >= 1 &&
        r.limit <= 10
      );
    case 'file.paste':
      return only('chatId') && id(r.chatId);
    case 'chat.read':
      return only('chatId', 'upTo') && id(r.chatId) && id(r.upTo);
    case 'chat.view':
      return only('chatId') && (r.chatId === null || id(r.chatId));
    case 'open.site':
      return only('path') && text(r.path, 16000);
    case 'open.link':
      return only('url') && text(r.url, 16000);
    case 'open.path':
      return only('path', 'reveal') && text(r.path, 32767) && typeof r.reveal === 'boolean';
    case 'file.preview':
    case 'file.action':
      return (
        only('chatId', 'messageId', 'fileId', ...(r.kind === 'file.action' ? ['action'] : [])) &&
        id(r.chatId) &&
        id(r.messageId) &&
        id(r.fileId) &&
        (r.kind === 'file.preview' || ['save', 'open', 'reveal'].includes(String(r.action)))
      );
    case 'focus.set':
      return only('minutes') && [0, 30, 60, 480].includes(r.minutes as number);
    case 'notifications.read':
      return only('id') && (r.id === 'all' || id(r.id));
    default:
      return false;
  }
}
