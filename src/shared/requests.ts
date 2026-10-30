import type { DesktopRequest } from './desktop';
import { REACTION_KINDS } from './client';
import { expectedValid, timerRowsValid } from './time';
import { preferenceTabs, preferencesPatchValid } from './preferences';
import { releaseVersionValid } from './updates';
import { reportOptionsValid } from './report';
const id = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const text = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
export function requestValid(raw: unknown): raw is DesktopRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string') return false;
  const scoped = ![
    'init',
    'login',
    'retry',
    'theme',
    'window.hide',
    'app.quit',
    'settings.read',
    'settings.patch',
    'settings.open',
    'logs.open',
    'updates.check',
    'updates.later',
    'server.read',
    'server.check',
    'server.apply',
    'setup.open',
    'setup.inventory',
    'report.open',
    'report.clear',
    'report.edit',
    'report.screens',
    'report.capture',
    'report.prepare',
    'report.export',
    'report.reveal',
  ].includes(String(r.kind));
  if (scoped && (typeof r.epoch !== 'number' || !Number.isSafeInteger(r.epoch) || r.epoch < 0))
    return false;
  const only = (...keys: string[]) =>
    Object.keys(r).every((k) => k === 'kind' || (scoped && k === 'epoch') || keys.includes(k));
  switch (r.kind) {
    case 'report.send':
    case 'report.retry':
    case 'report.fallback':
      return (
        only('id') &&
        typeof r.id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.id)
      );
    case 'report.resolve':
      return (
        only('id', 'confirmed') &&
        typeof r.id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(r.id) &&
        r.confirmed === true
      );
    case 'report.open':
    case 'report.clear':
    case 'report.edit':
    case 'report.screens':
      return only();
    case 'report.prepare':
      return only('options') && reportOptionsValid(r.options);
    case 'report.export':
    case 'report.reveal':
      return only('id') && typeof r.id === 'string' && /^[0-9a-f-]{36}$/.test(r.id);
    case 'report.capture': {
      if (!only('target') || !r.target || typeof r.target !== 'object' || Array.isArray(r.target))
        return false;
      const target = r.target as Record<string, unknown>;
      return target.type === 'window'
        ? Object.keys(target).length === 1
        : target.type === 'screen' &&
            Object.keys(target).length === 2 &&
            typeof target.id === 'string' &&
            /^-?\d{1,18}$/.test(target.id);
    }
    case 'setup.finish':
      return only('autostart') && typeof r.autostart === 'boolean';
    case 'setup.open':
      return only();
    case 'setup.inventory':
      return only('refresh') && (r.refresh === undefined || typeof r.refresh === 'boolean');
    case 'server.read':
      return only();
    case 'server.check':
      return only('url') && text(r.url, 2048);
    case 'server.apply':
      return (
        only('url', 'token') &&
        text(r.url, 2048) &&
        typeof r.token === 'string' &&
        /^[0-9a-f-]{36}$/.test(r.token)
      );
    case 'updates.check':
      return only();
    case 'updates.later':
      return only('version') && releaseVersionValid(r.version);
    case 'settings.read':
    case 'logs.open':
      return only();
    case 'settings.open':
      return (
        only('tab') && preferenceTabs.includes(r.tab as import('./preferences').PreferencesTab)
      );
    case 'settings.patch':
      return only('patch') && preferencesPatchValid(r.patch);
    case 'timer.read':
      return only();
    case 'timer.options':
      return only('q') && (r.q === undefined || text(r.q, 200));
    case 'timer.open':
      return (
        only('mode', 'taskId') &&
        ['pick', 'finish'].includes(String(r.mode)) &&
        (r.taskId === undefined || id(r.taskId))
      );
    case 'timer.absenceDismiss':
      return only('id') && id(r.id);
    case 'timer.preferences':
      return (
        only('reminderTime', 'pauseOnLock', 'askOnUnlock') &&
        (r.pauseOnLock === undefined || typeof r.pauseOnLock === 'boolean') &&
        (r.askOnUnlock === undefined || typeof r.askOnUnlock === 'boolean') &&
        typeof r.reminderTime === 'string' &&
        r.reminderTime.length === 5 &&
        /^([01]\d|2[0-3]):(00|30)$/.test(r.reminderTime)
      );
    case 'timer.start':
      return (
        only('taskId', 'expected') &&
        id(r.taskId) &&
        (r.expected === null || expectedValid(r.expected))
      );
    case 'timer.pause':
    case 'timer.resume':
    case 'timer.extend':
    case 'timer.reset':
    case 'timer.proposal':
      return only('expected') && expectedValid(r.expected);
    case 'timer.finish':
      return (
        only('expected', 'rows', 'note', 'preparedRequestId') &&
        expectedValid(r.expected) &&
        timerRowsValid(r.rows) &&
        text(r.note, 500) &&
        typeof r.preparedRequestId === 'string' &&
        /^[A-Za-z0-9._:-]{8,100}$/.test(r.preparedRequestId)
      );
    case 'timer.validateRows':
      return (
        only('preparedRequestId', 'rows') &&
        typeof r.preparedRequestId === 'string' &&
        /^[A-Za-z0-9._:-]{8,100}$/.test(r.preparedRequestId) &&
        timerRowsValid(r.rows)
      );
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
    case 'chat.objectInfo':
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
    case 'chat.top':
      return only('chatId', 'top') && id(r.chatId) && typeof r.top === 'boolean';
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
        REACTION_KINDS.some((kind) => kind === r.reaction) &&
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
