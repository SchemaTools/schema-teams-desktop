import type {
  ChatDetail,
  ChatFile,
  ChatList,
  ChatMessage,
  ChatMessageEvent,
  ChatPoll,
  ChatReaction,
  ChatSticker,
  ChatAttachmentPage,
  ChatSummary,
  FocusState,
  FocusSummary,
  Health,
  MessagePage,
  NotificationItem,
  NotificationPush,
  NotificationPage,
  NotificationSettings,
  PersonRef,
  SafeUser,
  ObjectInfo,
} from '../../shared/client';
import type { MorningSummary } from '../../shared/morning';
import type { SupportReceipt } from '../../shared/report';
import { isoDay } from '../../shared/time';

export class InvalidData extends Error {}
/** Что пропущено при мягком разборе (ТЗ 3.3): вид элемента, без содержимого. */
export type SkippedKind =
  'chat' | 'message' | 'reaction' | 'file' | 'link' | 'card' | 'mention' | 'sticker';
let skipped: ((kind: SkippedKind) => void) | undefined;
/** Владелец журнала подписывается один раз; сам разбор не знает о журнале. */
export function onSkipped(listener: ((kind: SkippedKind) => void) | undefined): void {
  skipped = listener;
}
/** Мягкий разбор списка: негодный элемент пропускается с записью в журнал, а не роняет весь ответ. */
const tolerant = <T>(
  value: unknown,
  parse: (v: unknown) => T,
  kind: SkippedKind,
  max = 10000,
): T[] => {
  if (!Array.isArray(value)) throw new InvalidData();
  const result: T[] = [];
  for (const item of value.slice(0, max)) {
    try {
      result.push(parse(item));
    } catch {
      skipped?.(kind);
    }
  }
  if (value.length > max) skipped?.(kind);
  return result;
};
/** Необязательное поле: нет — значение по умолчанию, есть — проверяется. */
const optional = <T>(value: unknown, parse: (v: unknown) => T, fallback: T): T =>
  value === undefined ? fallback : parse(value);
/** Служебные сообщения бывают длиннее лимита отправки 4000 — разумный верхний предел. */
export const MESSAGE_TEXT_LIMIT = 64000;
export function morning(v: unknown): MorningSummary {
  const x = object(v);
  if (!isoDay(x.date)) throw new InvalidData();
  return {
    date: x.date,
    workday: flag(x.workday),
    dueToday: count(x.dueToday),
    review: count(x.review),
    newRemarks: count(x.newRemarks),
  };
}
export function supportReceipt(v: unknown): SupportReceipt {
  const x = object(v);
  return { chatId: id(x.chatId), messageId: id(x.messageId) };
}
export const object = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new InvalidData();
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 32000): string => {
  if (typeof v !== 'string' || v.length > max) throw new InvalidData();
  return v;
};
const flag = (v: unknown): boolean => {
  if (typeof v !== 'boolean') throw new InvalidData();
  return v;
};
const count = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new InvalidData();
  return v;
};
export const id = (v: unknown): number => {
  const n = count(v);
  if (n === 0) throw new InvalidData();
  return n;
};
const date = (v: unknown): string => {
  const s = text(v, 64);
  if (!Number.isFinite(Date.parse(s))) throw new InvalidData();
  return s;
};
const nullable = <T>(value: unknown, parse: (v: unknown) => T): T | null =>
  value === null ? null : parse(value);
/** `GET /api/chats/:id/attachments` — вложения чата; негодная запись пропускается. */
export const attachments = (v: unknown): ChatAttachmentPage => {
  const x = object(v);
  return {
    items: tolerant(
      x.items,
      (item) => {
        const y = object(item);
        return {
          id: id(y.id),
          messageId: id(y.messageId),
          at: date(y.at),
          authorShortName: nullable(y.authorShortName ?? null, (s) => text(s, 1000)),
          file: file(y.file),
        };
      },
      'file',
      100,
    ),
    hasMore: flag(x.hasMore),
  };
};
/** `GET /api/chat-stickers` — набор бюро; незнакомый вид или негодная запись пропускается. */
export const stickers = (v: unknown): ChatSticker[] =>
  tolerant(
    v,
    (item) => {
      const x = object(item);
      if (x.kind !== 'sticker' && x.kind !== 'emoji') throw new InvalidData();
      return {
        id: id(x.id),
        kind: x.kind,
        name: text(x.name ?? '', 64),
        fileId: id(x.fileId),
        author: nullable(x.author ?? null, person),
      };
    },
    'sticker',
    1000,
  );
/** `GET /api/profile` — из профиля приложению нужно только фото (шапка меню трея). */
export const profilePhoto = (v: unknown): number | null => {
  const photo = object(v).photoFileId;
  return photo === undefined ? null : nullable(photo, id);
};
const array = <T>(value: unknown, parse: (v: unknown) => T, max = 10000): T[] => {
  if (!Array.isArray(value) || value.length > max) throw new InvalidData();
  return value.map(parse);
};
const person = (v: unknown): PersonRef => {
  const x = object(v);
  return { id: id(x.id), shortName: text(x.shortName, 1000) };
};
export function session(v: unknown): { user: SafeUser; csrf: string } {
  const x = object(v),
    u = object(x.user),
    csrf = text(x.csrfToken, 1000);
  if (!csrf || /[\r\n]/.test(csrf)) throw new InvalidData();
  return {
    user: {
      id: id(u.id),
      shortName: text(u.shortName, 1000),
      mustChangePassword: flag(u.mustChangePassword),
    },
    csrf,
  };
}
export function health(v: unknown): Health {
  const x = object(v);
  if (!['ok', 'error'].includes(String(x.status)) || !['ok', 'down'].includes(String(x.db)))
    throw new InvalidData();
  const version = text(x.version, 100);
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version)) throw new InvalidData();
  return { status: x.status as Health['status'], db: x.db as Health['db'], version };
}
export function summary(v: unknown): ChatSummary {
  const x = object(v);
  if (!['direct', 'group', 'object', 'bureau'].includes(String(x.kind))) throw new InvalidData();
  const last = nullable(x.last, (v) => {
    const y = object(v);
    return {
      id: id(y.id),
      authorShortName: nullable(y.authorShortName, text),
      authorId: nullable(y.authorId, id),
      preview: text(y.preview),
      at: date(y.at),
      deleted: flag(y.deleted),
    };
  });
  return {
    id: id(x.id),
    kind: x.kind as ChatSummary['kind'],
    title: text(x.title, 1000),
    peer: nullable(x.peer, person),
    objectId: nullable(x.objectId, id),
    objectCode: nullable(x.objectCode, text),
    memberCount: count(x.memberCount),
    last,
    unread: count(x.unread),
    mentioned: flag(x.mentioned),
    photoFileId: nullable(x.photoFileId, id),
    ...(x.myActiveTasks !== undefined && {
      myActiveTasks: x.myActiveTasks === null ? null : count(x.myActiveTasks),
    }),
    ...(x.top !== undefined && { top: x.top === null ? null : flag(x.top) }),
  };
}
/** Socket-only metadata; missing quiet remains unknown for legacy servers. */
export function messageEvent(v: unknown): ChatMessageEvent {
  const x = object(v);
  return { ...message(v), quiet: x.quiet === undefined ? null : flag(x.quiet) };
}
export function notificationPush(v: unknown): NotificationPush {
  const x = object(v),
    item = notification(x.item);
  if (text(x.kind, 100) !== item.event || id(x.notificationId) !== item.id) throw new InvalidData();
  return { item, kind: item.event, quiet: flag(x.quiet), notificationId: item.id };
}
export function list(v: unknown): ChatList {
  const x = object(v);
  // Неизвестный вид чата или негодная строка — пропускается этот чат, а не весь список.
  return { items: tolerant(x.items, summary, 'chat'), unreadTotal: count(x.unreadTotal) };
}
export const file = (v: unknown): ChatFile => {
  const x = object(v);
  return {
    fileId: id(x.fileId),
    fileName: text(x.fileName, 2000),
    size: count(x.size),
    mime: text(x.mime, 200),
    isImage: flag(x.isImage),
  };
};
const reaction = (v: unknown): ChatReaction => {
  const x = object(v);
  return { kind: text(x.kind, 100), users: array(x.users, person) };
};
export const reactions = (v: unknown): ChatReaction[] => array(v, reaction, 100);
const poll = (v: unknown): ChatPoll => {
  const x = object(v);
  return {
    id: id(x.id),
    question: text(x.question),
    options: array(
      x.options,
      (v) => {
        const y = object(v);
        return {
          text: text(y.text),
          votes: nullable(y.votes, count),
          voters: array(y.voters, person),
        };
      },
      100,
    ),
    multi: flag(x.multi),
    anonymous: flag(x.anonymous),
    closesAt: nullable(x.closesAt, date),
    closed: flag(x.closed),
    remind: flag(x.remind),
    mine: array(x.mine, count, 100),
    answered: count(x.answered),
    total: count(x.total),
    canManage: flag(x.canManage),
  };
};
export function message(v: unknown): ChatMessage {
  const x = object(v);
  // Обязательны id, чат, время и текст; остальное необязательно, негодные элементы
  // списков пропускаются (ТЗ 3.3, мягкая деградация).
  const list = <T>(value: unknown, parse: (v: unknown) => T, kind: SkippedKind, max?: number) =>
    value === undefined ? [] : tolerant(value, parse, kind, max);
  return {
    id: id(x.id),
    chatId: id(x.chatId),
    author: optional(x.author, (v) => nullable(v, person), null),
    text: text(x.text, MESSAGE_TEXT_LIMIT),
    at: date(x.at),
    editedAt: optional(x.editedAt, (v) => nullable(v, date), null),
    deleted: optional(x.deleted, flag, false),
    replyTo: optional(
      x.replyTo,
      (v) =>
        nullable(v, (v) => {
          const y = object(v);
          return {
            id: id(y.id),
            authorShortName: optional(y.authorShortName, (v) => nullable(v, text), null),
            preview: text(y.preview),
            deleted: optional(y.deleted, flag, false),
          };
        }),
      null,
    ),
    files: list(x.files, file, 'file', 100),
    mentions: list(x.mentions, id, 'mention'),
    links: list(
      x.links,
      (v) => {
        const y = object(v);
        return { text: text(y.text), taskId: id(y.taskId), title: text(y.title) };
      },
      'link',
    ),
    canEdit: optional(x.canEdit, flag, false),
    reactions: list(x.reactions, reaction, 'reaction', 100),
    cards: list(
      x.cards,
      (v) => {
        const y = object(v);
        return { type: text(y.type, 100), id: id(y.id) };
      },
      'card',
      100,
    ),
    sticker: optional(
      x.sticker,
      (v) =>
        nullable(v, (v) => {
          const y = object(v);
          return { id: id(y.id), fileId: nullable(y.fileId, id) };
        }),
      null,
    ),
    poll: optional(x.poll, (v) => nullable(v, poll), null),
  };
}
export function messages(v: unknown): MessagePage {
  const x = object(v);
  // Размер страницы задаёт сервер (сейчас 50); больше — не ошибка.
  return {
    items: tolerant(x.items, message, 'message'),
    hasMore: flag(x.hasMore),
    hasNewer: flag(x.hasNewer),
  };
}
export function detail(v: unknown): ChatDetail {
  const x = object(v);
  return {
    chat: summary(x.chat),
    members: array(x.members, (v) => {
      const y = object(v);
      return {
        user: person(y.user),
        readUpTo: nullable(y.readUpTo, id),
        photoFileId: nullable(y.photoFileId, id),
      };
    }),
    canManageMembers: flag(x.canManageMembers),
    canLeave: flag(x.canLeave),
    canWrite: flag(x.canWrite),
    canPin: flag(x.canPin),
    taskStageId: nullable(x.taskStageId, id),
    pinned: nullable(x.pinned, (v) => {
      const y = object(v);
      return {
        id: id(y.id),
        authorShortName: nullable(y.authorShortName, text),
        preview: text(y.preview),
      };
    }),
  };
}
export function objectInfo(v: unknown): ObjectInfo {
  const x = object(v);
  if (!['active', 'paused', 'archive'].includes(String(x.status))) throw new InvalidData();
  const day = (value: unknown) => {
    const result = text(value, 10);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString().slice(0, 10) !== result
    )
      throw new InvalidData();
    return result;
  };
  const stages = array(
    x.stages,
    (v) => {
      const s = object(v);
      return {
        id: id(s.id),
        code: text(s.code, 100),
        name: text(s.name, 1000),
        startDate: day(s.startDate),
        endDate: day(s.endDate),
        closed: flag(s.closed),
      };
    },
    100,
  );
  const currentStageId = nullable(x.currentStageId, id);
  if (
    new Set(stages.map((s) => s.id)).size !== stages.length ||
    (currentStageId !== null && !stages.some((s) => s.id === currentStageId))
  )
    throw new InvalidData();
  return {
    id: id(x.id),
    code: text(x.code, 100),
    name: text(x.name, 1000),
    fullName: nullable(x.fullName, (v) => text(v, 4000)),
    client: nullable(x.client, (v) => text(v, 4000)),
    address: nullable(x.address, (v) => text(v, 4000)),
    status: x.status as ObjectInfo['status'],
    statusNote: nullable(x.statusNote, (v) => text(v, 4000)),
    gip: nullable(x.gip, person),
    gap: nullable(x.gap, person),
    pm: nullable(x.pm, person),
    folderRoot: nullable(x.folderRoot, (v) => text(v, 32767)),
    modelPath: nullable(x.modelPath, (v) => text(v, 32767)),
    currentStageId,
    stages,
  };
}
export function notification(v: unknown): NotificationItem {
  const x = object(v);
  return {
    id: id(x.id),
    event: text(x.event, 100),
    at: date(x.at),
    read: flag(x.read),
    author: nullable(x.author, (v) => {
      const y = object(v);
      return { ...person(y), photoFileId: nullable(y.photoFileId, id) };
    }),
    task: nullable(x.task, (v) => {
      const y = object(v);
      return {
        id: id(y.id),
        kind: text(y.kind, 100),
        mark: nullable(y.mark, text),
        title: text(y.title),
        objectName: nullable(y.objectName, text),
        stageCode: nullable(y.stageCode, text),
      };
    }),
    changes: array(
      x.changes,
      (v) => {
        const y = object(v);
        return {
          field: text(y.field, 100),
          from: nullable(y.from, text),
          to: nullable(y.to, text),
        };
      },
      100,
    ),
    reason: nullable(x.reason, text),
    subject: nullable(x.subject, text),
    link: nullable(x.link, text),
  };
}
export function notifications(v: unknown): NotificationPage {
  const x = object(v);
  return {
    items: array(x.items, notification, 100),
    unread: count(x.unread),
    nextBefore: nullable(x.nextBefore, id),
  };
}
export function unread(v: unknown): { unread: number } {
  return { unread: count(object(v).unread) };
}
export function focus(v: unknown): FocusState {
  const x = object(v);
  return { until: nullable(x.until, date), startedAt: nullable(x.startedAt, date) };
}
export function focusSummary(v: unknown): FocusSummary {
  const x = object(v);
  return {
    messages: count(x.messages),
    mentions: count(x.mentions),
    chats: array(x.chats, (v) => {
      const y = object(v);
      return {
        chatId: id(y.chatId),
        title: text(y.title),
        count: count(y.count),
        mentions: count(y.mentions),
        last: array(y.last, text, 2),
      };
    }),
  };
}
export function acknowledged(v: unknown): null {
  if (object(v).ok !== true) throw new InvalidData();
  return null;
}
export function notificationSettings(v: unknown): NotificationSettings {
  const x = object(v);
  const time = (v: unknown): string => {
    const s = text(v, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new InvalidData();
    return s;
  };
  return {
    rows: array(
      x.rows,
      (v) => {
        const y = object(v);
        return { key: text(y.key, 100), inApp: flag(y.inApp) };
      },
      1000,
    ),
    digestHourly: flag(x.digestHourly),
    quiet: nullable(x.quiet, (v) => {
      const y = object(v);
      return { from: time(y.from), to: time(y.to) };
    }),
  };
}
/** `GET /api/chats/people?q=` — коллеги для нового чата; негодная строка — весь ответ негоден. */
export function people(v: unknown): PersonRef[] {
  const list = array(v, person, 50);
  if (new Set(list.map((p) => p.id)).size !== list.length) throw new InvalidData();
  return list;
}
/** Не больше стольких сотрудников в снимке присутствия — с запасом на любое бюро. */
const PRESENCE_LIMIT = 5000;
/**
 * `GET /api/chats/presence` → `{online, lastSeen}`; `focus` здесь не нужен (свой «Фокус» —
 * `GET /api/focus`). Ид — строго положительные целые, время — разбираемое ISO.
 */
export function presenceSnapshot(v: unknown): { online: number[]; lastSeen: Map<number, string> } {
  const x = object(v);
  const online = [...new Set(array(x.online, id, PRESENCE_LIMIT))];
  const raw = object(x.lastSeen);
  const keys = Object.keys(raw);
  if (keys.length > PRESENCE_LIMIT) throw new InvalidData();
  const lastSeen = new Map<number, string>();
  for (const key of keys) {
    if (!/^[1-9]\d{0,15}$/.test(key)) throw new InvalidData();
    lastSeen.set(id(Number(key)), date(raw[key]));
  }
  return { online, lastSeen };
}
/** Событие `chat:presence` → `{userId, online, lastSeen}`; `focusUntil` не нужен окну. */
export function presenceChange(v: unknown): {
  userId: number;
  online: boolean;
  lastSeen: string | null;
} {
  const x = object(v);
  return { userId: id(x.userId), online: flag(x.online), lastSeen: nullable(x.lastSeen, date) };
}
