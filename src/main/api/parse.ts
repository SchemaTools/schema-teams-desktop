import type {
  ChatDetail,
  ChatFile,
  ChatList,
  ChatMessage,
  ChatPoll,
  ChatReaction,
  ChatSummary,
  FocusState,
  FocusSummary,
  Health,
  MessagePage,
  NotificationItem,
  NotificationPage,
  NotificationSettings,
  PersonRef,
  SafeUser,
} from '../../shared/client';

export class InvalidData extends Error {}
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
  };
}
export function list(v: unknown): ChatList {
  const x = object(v);
  return { items: array(x.items, summary), unreadTotal: count(x.unreadTotal) };
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
  return {
    id: id(x.id),
    chatId: id(x.chatId),
    author: nullable(x.author, person),
    text: text(x.text, 4000),
    at: date(x.at),
    editedAt: nullable(x.editedAt, date),
    deleted: flag(x.deleted),
    replyTo: nullable(x.replyTo, (v) => {
      const y = object(v);
      return {
        id: id(y.id),
        authorShortName: nullable(y.authorShortName, text),
        preview: text(y.preview),
        deleted: flag(y.deleted),
      };
    }),
    files: array(x.files, file, 10),
    mentions: array(x.mentions, id, 10000),
    links: array(x.links, (v) => {
      const y = object(v);
      return { text: text(y.text), taskId: id(y.taskId), title: text(y.title) };
    }),
    canEdit: flag(x.canEdit),
    reactions: array(x.reactions, reaction, 100),
    cards: array(
      x.cards,
      (v) => {
        const y = object(v);
        return { type: text(y.type, 100), id: id(y.id) };
      },
      50,
    ),
    sticker: nullable(x.sticker, (v) => {
      const y = object(v);
      return { id: id(y.id), fileId: nullable(y.fileId, id) };
    }),
    poll: nullable(x.poll, poll),
  };
}
export function messages(v: unknown): MessagePage {
  const x = object(v);
  return {
    items: array(x.items, message, 50),
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
