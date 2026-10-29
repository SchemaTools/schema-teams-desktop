import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowSquareOut,
  At,
  Bell,
  Buildings,
  ChatCircleDots,
  ClipboardText,
  ClockCountdown,
  Check,
  File,
  GearSix,
  Info,
  List,
  Moon,
  PaperPlaneTilt,
  Paperclip,
  PushPin,
  SignIn,
  SignOut,
  Stack,
  User,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import type {
  ChatDetail,
  ChatFile,
  ChatMessage,
  ChatSummary,
  NotificationItem,
} from '../shared/client';
import type { ClientSnapshot } from '../shared/desktop';
import { request } from './bridge';
import { Avatar, MessageBubble, SchemaLogo } from './content';
import {
  chatLink,
  chatTitle,
  dateLabel,
  filteredChats,
  mergeMessages,
  needsReply,
  rowDate,
  timeLabel,
  type Folder,
  type Selection,
} from './model';
import { R } from './strings';
import { U } from './uploadStrings';
import './composer.css';
import { TypingStatus } from './typing';
import { ChatSearch } from './chatSearch';
import { EmojiPicker } from './emojiPicker';
import { ObjectInfoPanel } from './objectInfo';
import './events.css';
import { TimerPanel } from './timer';
import { PreferencesPanel } from './preferences';
import { UpdateBanner } from './updates';
import { ServerConfigurationPanel } from './serverConfiguration';

const EMPTY: ClientSnapshot = {
  connection: 'connecting',
  user: null,
  serverVersion: '',
  appVersion: '',
  epoch: 0,
  revision: 0,
  theme: 'light',
  themePreference: 'system',
  chats: [],
  unread: 0,
  notifications: [],
  notificationUnread: 0,
  focus: { until: null, startedAt: null },
  error: null,
};
interface Draft {
  value: string;
  files: ChatFile[];
  uploading: boolean;
  pending: boolean;
  error: string;
  uploadError: string;
  uncertain: boolean;
  reply?: { id: number; author: string; preview: string };
  intent?: { text: string; fileIds: number[]; requestId: string; replyTo?: number };
}
const emptyDraft = (): Draft => ({
  value: '',
  files: [],
  uploading: false,
  pending: false,
  error: '',
  uploadError: '',
  uncertain: false,
});
const sameFileIds = (a: number[], b: number[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

export function App() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot>(EMPTY);
  const snapshotRef = useRef(snapshot);
  const [folder, setFolder] = useState<Folder>('all');
  const [selection, setSelection] = useState<Selection>(null);
  const selectionRef = useRef<Selection>(null);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState(false);
  const [objectInfoOpen, setObjectInfoOpen] = useState(false);
  const objectInfoButton = useRef<HTMLButtonElement>(null);
  const [uiError, setUiError] = useState('');
  const [timerView, setTimerView] = useState<ClientSnapshot['navigateTimer']>(null);
  const [settingsView, setSettingsView] = useState<ClientSnapshot['navigateSettings']>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [messageOwner, setMessageOwner] = useState('');
  const [historyChat, setHistoryChat] = useState<number | null>(null);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const aroundRef = useRef<{ chatId: number; messageId: number } | null>(null);
  const navigationPending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const draftsRef = useRef(drafts);
  const [draftOwner, setDraftOwner] = useState('');
  const loadId = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const composerInput = useRef<HTMLTextAreaElement>(null);
  const readPending = useRef(new Set<number>());
  const readUpTo = useRef(new Map<number, number>());
  const markFrame = useRef(0);
  const displayedSelectionRevision = useRef(-1);
  const [newMessages, setNewMessages] = useState(0);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const owner = `${snapshot.epoch}:${snapshot.user?.id ?? ''}`;
  const online = snapshot.connection === 'online';

  const patchDraft = useCallback((chatId: number, change: (old: Draft) => Draft) => {
    const next = {
      ...draftsRef.current,
      [chatId]: change(draftsRef.current[chatId] ?? emptyDraft()),
    };
    draftsRef.current = next;
    setDrafts(next);
  }, []);

  useEffect(() => {
    const accept = (next: ClientSnapshot) => {
      const previous = snapshotRef.current;
      if (
        next.epoch < previous.epoch ||
        (next.epoch === previous.epoch && next.revision < previous.revision)
      )
        return;
      if (next.epoch !== previous.epoch || next.user?.id !== previous.user?.id) {
        loadId.current++;
        selectionRef.current = null;
        setSelection(null);
        setMessages([]);
        setDetail(null);
        setObjectInfoOpen(false);
        setTimerView(null);
        setMessageOwner('');
        setHistoryChat(null);
        aroundRef.current = null;
        setMessageError('');
        setUiError('');
        draftsRef.current = {};
        setDrafts({});
        setDraftOwner(`${next.epoch}:${next.user?.id ?? ''}`);
        readPending.current.clear();
        readUpTo.current.clear();
      }
      snapshotRef.current = next;
      if (
        next.navigateSettings &&
        next.navigateSettings.nonce !== previous.navigateSettings?.nonce
      ) {
        setSettingsView(next.navigateSettings);
        setMenu(false);
      }
      if (next.navigateTimer && next.navigateTimer.nonce !== previous.navigateTimer?.nonce) {
        setTimerView(next.navigateTimer);
        setSettingsView(null);
      }
      setSnapshot(next);
      document.documentElement.dataset.theme = next.theme;
    };
    if (!window.teams) {
      setUiError(R.bridgeError);
      return;
    }
    const unsubscribe = window.teams.subscribe(accept);
    void request({ kind: 'init' }).then((result) => {
      if (result.ok) accept(result.data);
      else setUiError(result.error);
    });
    return () => {
      unsubscribe();
      cancelAnimationFrame(markFrame.current);
    };
  }, []);

  const select = useCallback(
    (next: Selection, around?: number, expectedEpoch = snapshotRef.current.epoch) => {
      if (snapshotRef.current.epoch !== expectedEpoch) return;
      selectionRef.current = next;
      setSelection(next);
      navigationPending.current = true;
      setSelectionRevision((value) => value + 1);
      aroundRef.current =
        typeof next === 'number' && around !== undefined
          ? { chatId: next, messageId: around }
          : null;
      setMenu(false);
      setObjectInfoOpen(false);
      setMessageError('');
      setUiError('');
      if (typeof next === 'number') {
        const key = `${snapshotRef.current.epoch}:${snapshotRef.current.user?.id ?? ''}`;
        setDraftOwner(key);
        void request({ kind: 'chat.view', epoch: expectedEpoch, chatId: next });
      } else void request({ kind: 'chat.view', epoch: expectedEpoch, chatId: null });
    },
    [],
  );

  async function loadHistory(chatId: number, before?: number, around?: number, refresh = false) {
    const captured = snapshotRef.current;
    if (captured.epoch !== snapshot.epoch) return;
    if (!captured.user || captured.connection !== 'online') return;
    const ticket = ++loadId.current;
    const oldTop = scroll.current?.scrollTop ?? 0;
    const oldHeight = scroll.current?.scrollHeight ?? 0;
    const nearBottom = !scroll.current || oldHeight - oldTop - scroll.current.clientHeight < 100;
    const visibleId = scroll.current
      ? [...scroll.current.querySelectorAll<HTMLElement>('[data-message-id]')].find(
          (el) =>
            el.getBoundingClientRect().bottom > (scroll.current?.getBoundingClientRect().top ?? 0),
        )?.dataset.messageId
      : undefined;
    const targetAround =
      around ?? (refresh && !nearBottom && visibleId ? Number(visibleId) : undefined);
    setLoading(true);
    setMessageError('');
    const [page, info] = await Promise.all([
      request({
        kind: 'chat.messages',
        epoch: captured.epoch,
        chatId,
        ...(before !== undefined ? { before } : {}),
        ...(targetAround !== undefined ? { around: targetAround } : {}),
      }),
      request({ kind: 'chat.detail', epoch: captured.epoch, chatId }),
    ]);
    if (
      ticket !== loadId.current ||
      captured.epoch !== snapshotRef.current.epoch ||
      captured.user.id !== snapshotRef.current.user?.id ||
      selectionRef.current !== chatId
    )
      return;
    setLoading(false);
    if (!page.ok) {
      setMessageError(page.error);
      return;
    }
    if (!info.ok) {
      setMessageError(info.error);
      return;
    }
    setDetail(info.data);
    displayedSelectionRevision.current = selectionRevision;
    setMessageOwner(`${captured.epoch}:${captured.user.id}`);
    setHistoryChat(chatId);
    setMessages((old) =>
      before !== undefined || refresh ? mergeMessages(old, page.data.items) : page.data.items,
    );
    if (!refresh) setHasMore(page.data.hasMore);
    if (before === undefined && !refresh) setHasNewer(page.data.hasNewer);
    else if (refresh && nearBottom && targetAround === undefined) setHasNewer(false);
    if (refresh && !nearBottom) {
      const newest = info.data.chat.last?.id ?? 0;
      const oldNewest = messages[messages.length - 1]?.id ?? 0;
      if (newest > oldNewest)
        setNewMessages((value) => Math.max(value, info.data.chat.unread || 1));
    } else if (!refresh || nearBottom) setNewMessages(0);
    requestAnimationFrame(() => {
      if (
        ticket !== loadId.current ||
        captured.epoch !== snapshotRef.current.epoch ||
        selectionRef.current !== chatId
      )
        return;
      const viewport = scroll.current;
      if (!viewport) return;
      if (before !== undefined)
        viewport.scrollTo({ top: oldTop + viewport.scrollHeight - oldHeight, behavior: 'instant' });
      else if (refresh && !nearBottom) viewport.scrollTo({ top: oldTop, behavior: 'instant' });
      else if (around !== undefined)
        viewport
          .querySelector(`[data-message-id="${around}"]`)
          ?.scrollIntoView({ block: 'center', behavior: 'instant' });
      else viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
      if (before === undefined && !refresh) navigationPending.current = false;
      markVisible();
    });
  }

  useEffect(() => {
    if (typeof selection !== 'number' || !online) return;
    const around =
      aroundRef.current?.chatId === selection ? aroundRef.current.messageId : undefined;
    const refresh =
      historyChat === selection &&
      !navigationPending.current &&
      messageOwner === owner &&
      displayedSelectionRevision.current === selectionRevision;
    void loadHistory(selection, undefined, refresh ? undefined : around, refresh);
  }, [
    selection,
    selectionRevision,
    snapshot.epoch,
    snapshot.historyRevision ?? snapshot.revision,
    online,
  ]);

  useEffect(() => {
    const target = snapshot.navigateChat;
    if (!target || !snapshot.user) return;
    setFolder('all');
    select(target.chatId, target.messageId, snapshot.epoch);
  }, [snapshot.navigateChat?.nonce]);

  useEffect(() => {
    if (!snapshot.navigateEvents || !snapshot.user) return;
    setFolder('events');
    select('events', undefined, snapshot.epoch);
  }, [snapshot.navigateEvents]);

  const selectedChat =
    typeof selection === 'number' ? snapshot.chats.find((chat) => chat.id === selection) : null;
  const shownMessages = messageOwner === owner && historyChat === selection ? messages : [];
  const shownDetail = messageOwner === owner && historyChat === selection ? detail : null;
  const draft =
    typeof selection === 'number' && draftOwner === owner
      ? (drafts[selection] ?? emptyDraft())
      : emptyDraft();
  const draftIssue = [draft.error, draft.uploadError].filter(Boolean).join(' ');

  function markVisible() {
    cancelAnimationFrame(markFrame.current);
    markFrame.current = requestAnimationFrame(() => {
      const current = snapshotRef.current;
      const chatId = selectionRef.current;
      const viewport = scroll.current;
      if (
        typeof chatId !== 'number' ||
        !current.user ||
        current.connection !== 'online' ||
        !viewport ||
        document.hidden ||
        !document.hasFocus() ||
        readPending.current.has(chatId)
      )
        return;
      if (
        viewport.dataset.chatId !== String(chatId) ||
        viewport.dataset.owner !== `${current.epoch}:${current.user.id}`
      )
        return;
      const area = viewport.getBoundingClientRect();
      let last = 0;
      for (const element of viewport.querySelectorAll<HTMLElement>('[data-message-id]')) {
        const rect = element.getBoundingClientRect();
        if (rect.top < area.bottom && rect.bottom > area.top)
          last = Math.max(last, Number(element.dataset.messageId) || 0);
      }
      if (!last || last <= (readUpTo.current.get(chatId) ?? 0)) return;
      const epoch = current.epoch;
      readPending.current.add(chatId);
      void request({ kind: 'chat.read', epoch, chatId, upTo: last }).then((result) => {
        if (snapshotRef.current.epoch !== epoch) return;
        readPending.current.delete(chatId);
        if (result.ok) readUpTo.current.set(chatId, last);
      });
    });
  }

  useEffect(() => {
    window.addEventListener('focus', markVisible);
    document.addEventListener('visibilitychange', markVisible);
    return () => {
      window.removeEventListener('focus', markVisible);
      document.removeEventListener('visibilitychange', markVisible);
    };
  }, []);

  async function send() {
    const captured = snapshotRef.current;
    if (captured.epoch !== snapshot.epoch) return;
    const chatId = selectionRef.current;
    if (
      typeof chatId !== 'number' ||
      !captured.user ||
      captured.connection !== 'online' ||
      shownDetail?.canWrite !== true ||
      shownDetail.chat.id !== chatId
    )
      return;
    const current = draftsRef.current[chatId] ?? emptyDraft();
    const text = current.value.trim();
    const fileIds = current.files.map((file) => file.fileId);
    if ((!text && !fileIds.length) || current.pending || current.uploading) return;
    if (text.length > 4000) {
      patchDraft(chatId, (old) => ({ ...old, error: R.tooLong }));
      return;
    }
    const intent =
      current.intent?.text === text &&
      sameFileIds(current.intent.fileIds, fileIds) &&
      current.intent.replyTo === current.reply?.id
        ? current.intent
        : { text, fileIds, requestId: crypto.randomUUID(), replyTo: current.reply?.id };
    patchDraft(chatId, (old) => ({ ...old, intent, pending: true, error: '', uncertain: false }));
    const result = await request({
      kind: 'chat.send',
      epoch: captured.epoch,
      chatId,
      text,
      requestId: intent.requestId,
      ...(fileIds.length && { fileIds }),
      ...(intent.replyTo !== undefined && { replyTo: intent.replyTo }),
    });
    if (
      captured.epoch !== snapshotRef.current.epoch ||
      captured.user.id !== snapshotRef.current.user?.id
    )
      return;
    if (result.ok) {
      if (selectionRef.current === chatId) {
        setMessages((old) => mergeMessages(old, [result.data]));
        if (aroundRef.current?.chatId === chatId) {
          aroundRef.current = null;
          setSelectionRevision((value) => value + 1);
        }
        requestAnimationFrame(() => bottom.current?.scrollIntoView({ block: 'end' }));
      }
      patchDraft(chatId, (old) =>
        old.value.trim() === text &&
        old.reply?.id === intent.replyTo &&
        sameFileIds(
          old.files.map((file) => file.fileId),
          fileIds,
        )
          ? emptyDraft()
          : { ...old, pending: false, intent: undefined },
      );
    } else
      patchDraft(chatId, (old) => ({
        ...old,
        pending: false,
        error: result.uncertain ? R.uncertain : result.error,
        uncertain: result.uncertain === true,
      }));
  }

  async function uploadFiles(kind: 'pick' | 'paste') {
    const captured = snapshotRef.current;
    const chatId = selectionRef.current;
    if (
      captured.epoch !== snapshot.epoch ||
      typeof chatId !== 'number' ||
      !captured.user ||
      captured.connection !== 'online' ||
      shownDetail?.canWrite !== true ||
      shownDetail.chat.id !== chatId
    )
      return;
    const current = draftsRef.current[chatId] ?? emptyDraft();
    if (current.pending) return;
    if (current.uploading) {
      patchDraft(chatId, (old) => ({ ...old, uploadError: U.uploadBusy }));
      return;
    }
    if (current.files.length >= 10) {
      patchDraft(chatId, (old) => ({ ...old, uploadError: U.tooMany }));
      return;
    }
    patchDraft(chatId, (old) => ({ ...old, uploading: true, uploadError: '' }));
    const validOwner = () =>
      captured.epoch === snapshotRef.current.epoch &&
      captured.user?.id === snapshotRef.current.user?.id;
    if (kind === 'pick') {
      const result = await request({
        kind: 'file.pick',
        epoch: captured.epoch,
        chatId,
        limit: 10 - current.files.length,
      });
      if (!validOwner()) return;
      if (!result.ok) {
        patchDraft(chatId, (old) => ({ ...old, uploading: false, uploadError: result.error }));
        return;
      }
      patchDraft(chatId, (old) => {
        const known = new Set(old.files.map((file) => file.fileId));
        const incoming = result.data.items.filter((file) => {
          if (known.has(file.fileId)) return false;
          known.add(file.fileId);
          return true;
        });
        const files = [...old.files, ...incoming];
        return {
          ...old,
          uploading: false,
          files,
          uploadError: result.data.error ?? '',
          ...(incoming.length > 0 && { intent: undefined, uncertain: false, error: '' }),
        };
      });
    } else {
      const result = await request({ kind: 'file.paste', epoch: captured.epoch, chatId });
      if (!validOwner()) return;
      if (!result.ok) {
        patchDraft(chatId, (old) => ({ ...old, uploading: false, uploadError: result.error }));
        return;
      }
      const file = result.data;
      patchDraft(chatId, (old) =>
        file
          ? {
              ...old,
              uploading: false,
              files: [...old.files, file],
              error: '',
              uploadError: '',
              intent: undefined,
              uncertain: false,
            }
          : { ...old, uploading: false, uploadError: U.noClipboardImage },
      );
    }
  }

  function removeAttachment(chatId: number, fileId: number) {
    if (snapshotRef.current.epoch !== snapshot.epoch) return;
    patchDraft(chatId, (old) =>
      old.pending || old.uploading
        ? old
        : {
            ...old,
            files: old.files.filter((file) => file.fileId !== fileId),
            intent: undefined,
            error: '',
            uploadError: '',
            uncertain: false,
          },
    );
  }

  async function action(action: Parameters<typeof request>[0]) {
    if ('epoch' in action && snapshotRef.current.epoch !== action.epoch) return false;
    const result = await request(action);
    if ('epoch' in action && snapshotRef.current.epoch !== action.epoch) return false;
    if (!result.ok) setUiError(result.error);
    return result.ok;
  }

  function chooseFolder(next: Folder) {
    if (snapshotRef.current.epoch !== snapshot.epoch) return;
    setFolder(next);
    setSearch('');
    if (next === 'events') select('events', undefined, snapshot.epoch);
    else if (typeof selectionRef.current === 'number') {
      if (
        !filteredChats(snapshotRef.current.chats, next, '').some(
          (chat) => chat.id === selectionRef.current,
        )
      )
        select(null, undefined, snapshot.epoch);
    } else if (next !== 'all') select(null, undefined, snapshot.epoch);
  }

  const visibleChats = useMemo(
    () => filteredChats(snapshot.chats, folder, search),
    [snapshot.chats, folder, search],
  );
  const waiting = visibleChats.filter(needsReply);
  const rest = visibleChats.filter((chat) => !needsReply(chat));
  const showService =
    (folder === 'all' || folder === 'events') &&
    (!search.trim() || R.appName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const activeFocus =
    snapshot.focus.until !== null && Date.parse(snapshot.focus.until) > Date.now();

  function chatRow(chat: ChatSummary) {
    const title = chatTitle(chat);
    const own = chat.last?.authorId === snapshot.user?.id;
    return (
      <div className="chat-row-wrap" key={chat.id}>
        <button
          type="button"
          className={`chat-row${selection === chat.id ? ' selected' : ''}`}
          onClick={() => select(chat.id, undefined, snapshot.epoch)}
          aria-pressed={selection === chat.id}
          data-chat-id={chat.id}
        >
          <Avatar
            name={chat.kind === 'object' ? chat.objectCode || title : title}
            id={chat.peer?.id ?? chat.id}
            object={chat.kind === 'object'}
          />
          <span className="row-copy">
            <span className="row-top">
              <span className="row-name">{title}</span>
              <span className="row-meta">{rowDate(chat.last?.at)}</span>
            </span>
            <span className="row-bottom">
              <span className="preview">
                {chat.last
                  ? `${own ? R.you : chat.last.authorShortName || ''}${chat.last.authorShortName || own ? ': ' : ''}${chat.last.deleted ? R.deleted : chat.last.preview}`
                  : R.emptyPreview}
              </span>
              {chat.unread > 0 ? (
                <span className="unread-badge">{chat.unread > 99 ? '99+' : chat.unread}</span>
              ) : own ? (
                <Check size={15} />
              ) : null}
            </span>
          </span>
        </button>
        {chat.unread > 0 && chat.last && (
          <button
            type="button"
            className="chat-read-action"
            aria-label={`Прочитано: ${title}`}
            title="Прочитано"
            disabled={!online}
            onClick={() =>
              void action({ kind: 'chat.markRead', epoch: snapshot.epoch, chatId: chat.id })
            }
          >
            <Check size={16} />
          </button>
        )}
      </div>
    );
  }
  const serviceRow = (
    <button
      type="button"
      className={`chat-row${selection === 'events' ? ' selected' : ''}`}
      onClick={() => select('events', undefined, snapshot.epoch)}
      aria-pressed={selection === 'events'}
      data-chat-id="events"
    >
      <Avatar name={R.appName} id={0} bot />
      <span className="row-copy">
        <span className="row-top">
          <span className="row-name">{R.appName}</span>
        </span>
        <span className="row-bottom">
          <span className="preview">{R.servicePreview(snapshot.notificationUnread)}</span>
          {snapshot.notificationUnread > 0 && (
            <span className="unread-badge">
              {snapshot.notificationUnread > 99 ? '99+' : snapshot.notificationUnread}
            </span>
          )}
        </span>
      </span>
    </button>
  );

  function eventTitle(item: NotificationItem): string {
    if (item.event === 'timer_stopped') return R.eventTimerStopped;
    if (item.event.includes('mention')) return R.eventMention;
    if (item.event.includes('assigned')) return R.eventAssigned;
    if (item.event === 'due_soon') return R.eventDueSoon;
    if (item.event === 'overdue') return R.eventOverdue;
    if (
      item.event.includes('deadline') ||
      ['due_soon', 'overdue', 'due_changed'].includes(item.event)
    )
      return R.eventDeadline;
    return item.task ? R.eventUpdated : (item.subject ?? R.notification);
  }
  function eventCard(item: NotificationItem) {
    const target = chatLink(item.link);
    const category = item.event.includes('mention')
      ? 'mention'
      : item.event.includes('assigned')
        ? 'assigned'
        : item.event.includes('deadline') ||
            ['due_soon', 'overdue', 'due_changed'].includes(item.event)
          ? 'deadline'
          : item.event === 'timer_stopped'
            ? 'timer'
            : 'other';
    return (
      <article
        className={`event-stack event-${category}`}
        key={item.id}
        data-notification-id={item.id}
        data-event-kind={category}
      >
        <div className={`event-card${item.read ? '' : ' unread-event'}`}>
          <header>
            <span className="event-icon">
              {category === 'mention' ? (
                <At size={21} weight="duotone" />
              ) : category === 'assigned' ? (
                <ClipboardText size={21} weight="duotone" />
              ) : category === 'deadline' || category === 'timer' ? (
                <ClockCountdown size={21} weight="duotone" />
              ) : (
                <Bell size={21} weight="duotone" />
              )}
            </span>
            <div>
              <h2>{eventTitle(item)}</h2>
              {item.task && (
                <span className="muted-copy">
                  {[item.task.objectName, item.task.mark].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          </header>
          {item.task && <p>{item.task.title}</p>}
          {item.subject && <p>{item.subject}</p>}
          {item.reason && (
            <p>
              {category === 'timer' ? '' : `${R.eventReason}: `}
              {item.reason}
            </p>
          )}
          {category !== 'timer' &&
            item.changes.map((change, index) => (
              <p key={index}>
                {change.field}: {R.fromTo(change.from, change.to)}
              </p>
            ))}
          <div className="event-meta">
            {item.author?.shortName && `${item.author.shortName} · `}
            <time dateTime={item.at}>
              {dateLabel(item.at)}, {timeLabel(item.at)}
            </time>
          </div>
        </div>
        {item.link && (
          <div className="event-actions">
            <button
              type="button"
              onClick={() => {
                if (target) {
                  chooseFolder('all');
                  select(target.chatId, target.messageId, snapshot.epoch);
                } else if (item.link)
                  void action({ kind: 'open.site', epoch: snapshot.epoch, path: item.link });
                void action({ kind: 'notifications.read', epoch: snapshot.epoch, id: item.id });
              }}
            >
              {target ? (
                <ChatCircleDots size={16} weight="duotone" />
              ) : (
                <ArrowSquareOut size={16} weight="duotone" />
              )}
              {category === 'timer' ? R.checkTimeEntry : target ? R.openChat : R.openSite}
            </button>
          </div>
        )}
        {category === 'assigned' && item.task && (
          <div className="event-actions">
            <button
              type="button"
              disabled={!online}
              onClick={() => {
                if (item.task)
                  void action({
                    kind: 'timer.open',
                    epoch: snapshot.epoch,
                    mode: 'pick',
                    taskId: item.task.id,
                  });
              }}
            >
              <ClockCountdown size={16} weight="duotone" />
              Начать работу
            </button>
          </div>
        )}
      </article>
    );
  }

  function gate() {
    if (snapshot.connection === 'noServer')
      return (
        <Empty title={R.noServerTitle} text="Укажите адрес Teams и проверьте связь.">
          <ServerConfigurationPanel />
        </Empty>
      );
    if (snapshot.connection === 'incompatible')
      return <Empty title={R.incompatibleTitle} text={R.incompatibleHint} />;
    if (snapshot.connection === 'passwordChange')
      return (
        <Empty title={R.passwordTitle} text={R.passwordHint}>
          <button className="primary-button" onClick={() => void action({ kind: 'login' })}>
            <SignIn size={16} /> {R.continueLogin}
          </button>
        </Empty>
      );
    if (snapshot.connection === 'signedOut')
      return (
        <Empty title={R.loginTitle} text={R.loginHint}>
          <button className="primary-button" onClick={() => void action({ kind: 'login' })}>
            <SignIn size={16} /> {R.login}
          </button>
        </Empty>
      );
    if (snapshot.connection === 'connecting') return <Empty title={R.connecting} text="" />;
    return (
      <Empty title={R.offline} text={snapshot.error ?? R.offlineHint}>
        <button className="primary-button" onClick={() => void action({ kind: 'retry' })}>
          {R.retry}
        </button>
      </Empty>
    );
  }

  return (
    <div className="app-shell" data-connection={snapshot.connection}>
      {settingsView && (
        <PreferencesPanel
          key={settingsView.nonce}
          snapshot={snapshot}
          initialTab={settingsView.tab}
          onClose={() => {
            setSettingsView(null);
            requestAnimationFrame(() => {
              if (timerView)
                document
                  .querySelector<HTMLButtonElement>(
                    '.timer-panel button[aria-label="Закрыть таймер"]',
                  )
                  ?.focus();
              else menuButton.current?.focus();
            });
          }}
        />
      )}
      {timerView && snapshot.user && (
        <div hidden={Boolean(settingsView)}>
          <TimerPanel
            key={`${owner}:${timerView.nonce}`}
            snapshot={snapshot}
            mode={timerView.mode}
            taskId={timerView.taskId}
            onClose={() => setTimerView(null)}
          />
        </div>
      )}
      <nav className="folder-rail" aria-label={R.folders}>
        <button
          className="folder-button menu-button"
          aria-label={R.menu}
          aria-expanded={menu}
          ref={menuButton}
          onClick={() => setMenu(!menu)}
        >
          <List size={24} weight="duotone" />
        </button>
        {(
          [
            ['all', R.all, ChatCircleDots, snapshot.unread + snapshot.notificationUnread],
            [
              'objects',
              R.objects,
              Buildings,
              snapshot.chats
                .filter((chat) => chat.kind === 'object')
                .reduce((sum, chat) => sum + chat.unread, 0),
            ],
            ['personal', R.personal, User, 0],
            ['events', R.events, Bell, snapshot.notificationUnread],
          ] as const
        ).map(([key, label, Icon, count]) => (
          <button
            type="button"
            key={key}
            className={`folder-button${folder === key ? ' active' : ''}`}
            onClick={() => chooseFolder(key)}
            aria-pressed={folder === key}
          >
            <Icon size={24} weight={folder === key ? 'fill' : 'duotone'} />
            {label}
            {count > 0 && <b className="rail-count">{count > 99 ? '99+' : count}</b>}
          </button>
        ))}
        <button type="button" className="folder-button" disabled title={R.pluginsUnavailable}>
          <Stack size={24} weight="duotone" />
          {R.plugins}
        </button>
        <span className="rail-spacer" />
        <button
          type="button"
          className="folder-button"
          disabled={!snapshot.user}
          onClick={() =>
            void action({
              kind: 'timer.open',
              epoch: snapshot.epoch,
              mode: snapshot.timer ? 'finish' : 'pick',
            })
          }
        >
          <ClockCountdown size={24} weight="duotone" />
          Таймер
        </button>
        <button
          type="button"
          className="folder-button"
          onClick={() => void action({ kind: 'open.site', epoch: snapshot.epoch, path: '/' })}
        >
          <ArrowSquareOut size={24} weight="duotone" />
          {R.website}
        </button>
      </nav>
      {menu && (
        <section className="settings-popover" aria-label={R.settings}>
          <h2>{snapshot.user?.shortName ?? R.appName}</h2>
          <button onClick={() => void action({ kind: 'settings.open', tab: 'general' })}>
            <GearSix size={18} weight="duotone" />
            Настройки
          </button>
          <button onClick={() => void action({ kind: 'settings.open', tab: 'about' })}>
            <Info size={18} weight="duotone" />О программе
          </button>
          <label>
            <GearSix size={18} weight="duotone" />
            {R.theme}
            <select
              aria-label={R.theme}
              value={snapshot.themePreference}
              onChange={(event) =>
                void action({
                  kind: 'theme',
                  mode: event.target.value as 'system' | 'light' | 'dark',
                })
              }
            >
              <option value="system">{R.themeSystem}</option>
              <option value="light">{R.themeLight}</option>
              <option value="dark">{R.themeDark}</option>
            </select>
          </label>
          {online && (
            <>
              <button
                onClick={() => {
                  void action({
                    kind: 'focus.set',
                    epoch: snapshot.epoch,
                    minutes: activeFocus ? 0 : 30,
                  });
                  setMenu(false);
                }}
              >
                <Moon size={18} weight="duotone" />
                {activeFocus ? R.focusOff : R.focus30}
              </button>
              {!activeFocus && (
                <button
                  onClick={() => {
                    void action({ kind: 'focus.set', epoch: snapshot.epoch, minutes: 60 });
                    setMenu(false);
                  }}
                >
                  <Moon size={18} weight="duotone" />
                  {R.focus60}
                </button>
              )}
            </>
          )}
          <button
            onClick={() => {
              void action({ kind: 'open.site', epoch: snapshot.epoch, path: '/my' });
              setMenu(false);
            }}
          >
            <ArrowSquareOut size={18} weight="duotone" />
            {R.myTasks}
          </button>
          <button onClick={() => setMenu(false)}>
            <Check size={18} />
            {R.closeMenu}
          </button>
          {snapshot.user && (
            <button
              onClick={() => {
                setMenu(false);
                void action({ kind: 'logout', epoch: snapshot.epoch });
              }}
            >
              <SignOut size={18} weight="duotone" />
              {R.logout}
            </button>
          )}
        </section>
      )}
      <aside className="chat-list">
        <label className="search-field">
          <ChatCircleDots size={19} weight="duotone" />
          <span className="sr-only">{R.search}</span>
          <input
            type="search"
            aria-label={R.search}
            placeholder={R.searchPlaceholder}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="list-scroll">
          {snapshot.user && (
            <>
              {folder === 'events' ? (
                showService && serviceRow
              ) : (
                <>
                  {(waiting.length > 0 || (showService && snapshot.notificationUnread > 0)) && (
                    <section className="chat-group waiting">
                      <h2 className="group-label">
                        <ChatCircleDots size={15} weight="duotone" />
                        {R.waiting(
                          waiting.length + (showService && snapshot.notificationUnread > 0 ? 1 : 0),
                        )}
                      </h2>
                      {waiting.map(chatRow)}
                      {showService && snapshot.notificationUnread > 0 && serviceRow}
                    </section>
                  )}
                  {rest.map(chatRow)}
                  {showService && snapshot.notificationUnread === 0 && serviceRow}
                </>
              )}
              {!visibleChats.length && !showService && (
                <div className="empty-state small-empty">
                  <p>{search ? R.noResults : R.noChats}</p>
                  <p>{search ? R.noResultsHint : R.noChatsHint}</p>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="list-footer">
          <span title={R.version(snapshot.appVersion, snapshot.serverVersion)}>
            {snapshot.user?.shortName ?? R.appName}
          </span>
          <span>
            <i className={`status-dot${online ? '' : ' offline'}`} />
            {online
              ? R.online
              : snapshot.connection === 'connecting'
                ? R.connecting
                : snapshot.connection === 'signedOut'
                  ? R.signedOut
                  : R.offline}
          </span>
        </footer>
      </aside>
      <main className="conversation">
        <UpdateBanner snapshot={snapshot} />
        {snapshot.user && snapshot.connection !== 'passwordChange' ? (
          <>
            {snapshot.connection === 'offline' && (
              <div className="banner">
                <WarningCircle size={17} weight="duotone" />
                {R.offline}
                <button onClick={() => void action({ kind: 'retry' })}>{R.retry}</button>
              </div>
            )}
            {snapshot.timerAbsence && (
              <div className="banner" role="status">
                После блокировки или сна проверьте время таймера.{' '}
                <button
                  onClick={() =>
                    void action({ kind: 'timer.open', epoch: snapshot.epoch, mode: 'finish' })
                  }
                >
                  Проверить время
                </button>
              </div>
            )}
            {(uiError || snapshot.error) && (
              <div className="banner error-banner" role="status">
                <WarningCircle size={17} weight="duotone" />
                {uiError || snapshot.error}
              </div>
            )}
            {selection === 'events' ? (
              <>
                <header className="conversation-header">
                  <Avatar name={R.appName} id={0} bot small />
                  <div className="header-copy">
                    <h1>{R.appName}</h1>
                    <small>{R.eventsSubtitle}</small>
                  </div>
                  <button
                    className="secondary-button"
                    disabled={!online || snapshot.notificationUnread === 0}
                    onClick={() =>
                      void action({ kind: 'notifications.read', epoch: snapshot.epoch, id: 'all' })
                    }
                  >
                    {R.readAll}
                  </button>
                </header>
                <div className="chat-wall">
                  <div className="messages-scroll">
                    {snapshot.notifications.length ? (
                      snapshot.notifications.map(eventCard)
                    ) : (
                      <Empty title={R.noEvents} text={R.noEventsHint} />
                    )}
                  </div>
                </div>
              </>
            ) : selectedChat ? (
              <>
                <header className="conversation-header">
                  <Avatar
                    name={chatTitle(selectedChat)}
                    id={selectedChat.peer?.id ?? selectedChat.id}
                    object={selectedChat.kind === 'object'}
                    small
                  />
                  <div className="header-copy">
                    <h1>{chatTitle(selectedChat)}</h1>
                    <small>
                      {selectedChat.objectCode ? `${selectedChat.objectCode} · ` : ''}
                      <TypingStatus
                        entries={snapshot.typing}
                        chatId={selectedChat.id}
                        online={online}
                        fallback={R.members(
                          shownDetail?.members.length ?? selectedChat.memberCount,
                        )}
                      />
                    </small>
                  </div>
                  {activeFocus && (
                    <span className="muted-copy">
                      <Moon size={15} weight="duotone" />{' '}
                      {R.focusUntil(timeLabel(snapshot.focus.until ?? ''))}
                    </span>
                  )}
                  <ChatSearch
                    key={`${owner}:${selectedChat.id}`}
                    epoch={snapshot.epoch}
                    chatId={selectedChat.id}
                    online={online}
                    onJump={(id) => select(selectedChat.id, id, snapshot.epoch)}
                  />
                  {selectedChat.kind === 'object' && selectedChat.objectId !== null && (
                    <button
                      type="button"
                      className="icon-button"
                      ref={objectInfoButton}
                      aria-label="Об объекте"
                      aria-expanded={objectInfoOpen}
                      aria-controls={objectInfoOpen ? 'object-info-panel' : undefined}
                      disabled={!online}
                      onClick={() => setObjectInfoOpen((value) => !value)}
                    >
                      <Info size={20} weight="duotone" />
                    </button>
                  )}
                  <button
                    className="icon-button"
                    title={R.openChatWeb}
                    aria-label={R.openChatWeb}
                    onClick={() =>
                      void action({
                        kind: 'open.site',
                        epoch: snapshot.epoch,
                        path: `/chat/${selectedChat.id}`,
                      })
                    }
                  >
                    <ArrowSquareOut size={20} weight="duotone" />
                  </button>
                </header>
                <div className="conversation-workspace">
                  <div className="chat-wall">
                    {shownDetail?.pinned && (
                      <section className="pinned-message" aria-label="Закреплённое сообщение">
                        <button
                          type="button"
                          onClick={() =>
                            select(selectedChat.id, shownDetail.pinned?.id, snapshot.epoch)
                          }
                        >
                          <PushPin size={19} weight="duotone" />
                          <span className="pinned-copy">
                            <strong>
                              {shownDetail.pinned.authorShortName ?? 'Закреплённое сообщение'}
                            </strong>
                            <span>{shownDetail.pinned.preview}</span>
                          </span>
                        </button>
                        {shownDetail.canPin && (
                          <button
                            type="button"
                            className="unpin-message"
                            aria-label="Открепить сообщение"
                            disabled={!online || !shownDetail.canWrite}
                            onClick={() => {
                              void action({
                                kind: 'chat.pin',
                                epoch: snapshot.epoch,
                                chatId: selectedChat.id,
                                messageId: null,
                              });
                            }}
                          >
                            <X size={18} />
                          </button>
                        )}
                      </section>
                    )}
                    <div
                      className="messages-scroll"
                      ref={scroll}
                      onScroll={() => {
                        markVisible();
                        const viewport = scroll.current;
                        if (viewport) {
                          const away =
                            viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight >
                            100;
                          setAwayFromBottom(away);
                          if (!away) setNewMessages(0);
                        }
                      }}
                      aria-label={R.conversation}
                      data-chat-id={historyChat}
                      data-owner={messageOwner}
                    >
                      {hasMore && shownMessages.length > 0 && (
                        <button
                          className="history-button"
                          disabled={loading || !online}
                          onClick={() => {
                            const first = shownMessages[0];
                            if (first) void loadHistory(selectedChat.id, first.id);
                          }}
                        >
                          {loading ? R.loadingHistory : R.loadOlder}
                        </button>
                      )}
                      {messageError && (
                        <div className="inline-status error-copy" role="status">
                          {messageError}
                          <button
                            className="secondary-button"
                            onClick={() => void loadHistory(selectedChat.id)}
                            disabled={!online}
                          >
                            {R.retry}
                          </button>
                        </div>
                      )}
                      {loading && !shownMessages.length ? (
                        <Empty title={R.loadingHistory} text="" />
                      ) : !shownMessages.length && !messageError ? (
                        <Empty title={R.noMessages} text={R.noMessagesHint} />
                      ) : (
                        shownMessages.map((message, index) => (
                          <Fragment key={message.id}>
                            {dateLabel(shownMessages[index - 1]?.at ?? '') !==
                              dateLabel(message.at) && (
                              <div className="day-divider">
                                <span>{dateLabel(message.at)}</span>
                              </div>
                            )}
                            <MessageBubble
                              message={message}
                              firstInGroup={
                                !message.author ||
                                shownMessages[index - 1]?.author?.id !== message.author.id ||
                                dateLabel(shownMessages[index - 1]?.at ?? '') !==
                                  dateLabel(message.at)
                              }
                              lastInGroup={
                                !message.author ||
                                shownMessages[index + 1]?.author?.id !== message.author.id ||
                                dateLabel(shownMessages[index + 1]?.at ?? '') !==
                                  dateLabel(message.at)
                              }
                              epoch={snapshot.epoch}
                              ownId={snapshot.user?.id ?? 0}
                              read={
                                shownDetail?.members.some(
                                  (member) =>
                                    member.user.id !== snapshot.user?.id &&
                                    (member.readUpTo ?? 0) >= message.id,
                                ) ?? false
                              }
                              onError={(message) => {
                                if (snapshotRef.current.epoch === snapshot.epoch)
                                  setUiError(message);
                              }}
                              reactionsEnabled={online}
                              canWrite={shownDetail?.canWrite === true}
                              canPin={shownDetail?.canPin === true}
                              pinned={shownDetail?.pinned?.id === message.id}
                              onReply={() => {
                                if (
                                  snapshotRef.current.epoch !== snapshot.epoch ||
                                  !online ||
                                  !shownDetail?.canWrite ||
                                  message.deleted
                                )
                                  return;
                                patchDraft(selectedChat.id, (old) =>
                                  old.pending || old.uploading
                                    ? old
                                    : {
                                        ...old,
                                        reply: {
                                          id: message.id,
                                          author: message.author?.shortName ?? R.unknownAuthor,
                                          preview: message.text || 'Вложение',
                                        },
                                        intent: undefined,
                                        error: '',
                                        uncertain: false,
                                      },
                                );
                                requestAnimationFrame(() => composerInput.current?.focus());
                              }}
                              onChange={(updated) => {
                                if (
                                  snapshotRef.current.epoch !== snapshot.epoch ||
                                  selectionRef.current !== selectedChat.id
                                )
                                  return;
                                setMessages((old) => mergeMessages(old, [updated]));
                              }}
                              onPin={() => {
                                if (
                                  snapshotRef.current.epoch === snapshot.epoch &&
                                  selectionRef.current === selectedChat.id
                                )
                                  void loadHistory(selectedChat.id, undefined, undefined, true);
                              }}
                              onJump={(id) => select(selectedChat.id, id, snapshot.epoch)}
                              onReactions={(messageId, reactions) => {
                                if (
                                  snapshotRef.current.epoch !== snapshot.epoch ||
                                  selectionRef.current !== selectedChat.id
                                )
                                  return;
                                setMessages((old) =>
                                  old.map((item) =>
                                    item.id === messageId ? { ...item, reactions } : item,
                                  ),
                                );
                              }}
                            />
                          </Fragment>
                        ))
                      )}
                      <div ref={bottom} />
                    </div>
                    {(awayFromBottom || newMessages > 0 || hasNewer) && (
                      <button
                        type="button"
                        className="new-messages-button"
                        onClick={() => {
                          aroundRef.current = null;
                          setNewMessages(0);
                          setAwayFromBottom(false);
                          select(selectedChat.id, undefined, snapshot.epoch);
                        }}
                      >
                        К новым сообщениям{newMessages > 0 ? ` · ${newMessages}` : ''}
                      </button>
                    )}
                    {draft.reply && (
                      <section className="composer-context" aria-label="Ответ с цитатой">
                        <div className="composer-context-copy">
                          <strong>{draft.reply.author}</strong>
                          <span>{draft.reply.preview}</span>
                        </div>
                        <button
                          type="button"
                          aria-label="Отменить ответ с цитатой"
                          disabled={draft.pending || draft.uploading}
                          onClick={() =>
                            patchDraft(selectedChat.id, (old) => ({
                              ...old,
                              reply: undefined,
                              intent: undefined,
                              error: '',
                              uncertain: false,
                            }))
                          }
                        >
                          <X size={16} />
                        </button>
                      </section>
                    )}
                    {(draft.files.length > 0 || draft.uploading) && (
                      <section
                        className="composer-uploads"
                        aria-label={U.attachments}
                        data-chat-id={selectedChat.id}
                      >
                        {draft.files.length > 0 && (
                          <ul className="composer-upload-list">
                            {draft.files.map((file) => (
                              <li
                                key={file.fileId}
                                className="composer-upload-chip"
                                data-file-id={file.fileId}
                              >
                                <File size={19} weight="duotone" aria-hidden="true" />
                                <span className="composer-upload-copy">
                                  <span title={file.fileName}>{file.fileName}</span>
                                  <small>{U.fileSize(file.size)}</small>
                                </span>
                                <button
                                  type="button"
                                  aria-label={U.remove(file.fileName)}
                                  disabled={draft.pending || draft.uploading}
                                  onClick={() => removeAttachment(selectedChat.id, file.fileId)}
                                >
                                  <X size={15} weight="bold" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                        {draft.uploading && (
                          <span className="composer-upload-status" role="status">
                            {U.uploading}
                          </span>
                        )}
                      </section>
                    )}
                    <form
                      className="composer"
                      aria-busy={draft.uploading || draft.pending}
                      onSubmit={(event) => {
                        event.preventDefault();
                        void send();
                      }}
                    >
                      <div className="composer-field">
                        <button
                          type="button"
                          className="composer-attach-button"
                          aria-label={U.pickFiles}
                          title={U.limits}
                          disabled={
                            !online ||
                            draft.pending ||
                            draft.uploading ||
                            draft.files.length >= 10 ||
                            shownDetail?.canWrite !== true
                          }
                          onClick={() => void uploadFiles('pick')}
                        >
                          <Paperclip size={21} weight="duotone" />
                        </button>
                        <textarea
                          ref={composerInput}
                          rows={1}
                          aria-label={R.messagePlaceholder}
                          placeholder={R.messagePlaceholder}
                          maxLength={4000}
                          value={draft.value}
                          disabled={!online || draft.pending || shownDetail?.canWrite !== true}
                          onChange={(event) => {
                            if (snapshotRef.current.epoch !== snapshot.epoch) return;
                            const value = event.target.value;
                            if (value.trim() && online && shownDetail?.canWrite)
                              void request({
                                kind: 'chat.typing',
                                epoch: snapshot.epoch,
                                chatId: selectedChat.id,
                              });
                            patchDraft(selectedChat.id, (old) => ({
                              ...old,
                              value,
                              error: '',
                              uncertain: false,
                              ...(old.intent?.text !== value.trim() && { intent: undefined }),
                            }));
                          }}
                          onKeyDown={(event) => {
                            if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing &&
                              !event.repeat
                            ) {
                              event.preventDefault();
                              void send();
                            }
                          }}
                          onPaste={(event) => {
                            if (
                              ![...event.clipboardData.items].some(
                                (item) => item.kind === 'file' && item.type.startsWith('image/'),
                              )
                            )
                              return;
                            event.preventDefault();
                            void uploadFiles('paste');
                          }}
                        />
                        <EmojiPicker
                          key={`${owner}:${selectedChat.id}`}
                          disabled={!online || draft.pending || shownDetail?.canWrite !== true}
                          onPick={(emoji) => {
                            if (snapshotRef.current.epoch !== snapshot.epoch) return;
                            const input = composerInput.current,
                              start = input?.selectionStart ?? draft.value.length,
                              end = input?.selectionEnd ?? start;
                            patchDraft(selectedChat.id, (old) =>
                              old.value.length - (end - start) + emoji.length > 4000
                                ? { ...old, error: R.tooLong }
                                : {
                                    ...old,
                                    value: old.value.slice(0, start) + emoji + old.value.slice(end),
                                    intent: undefined,
                                    error: '',
                                    uncertain: false,
                                  },
                            );
                            requestAnimationFrame(() => {
                              if (snapshotRef.current.epoch !== snapshot.epoch) return;
                              input?.focus();
                              input?.setSelectionRange(start + emoji.length, start + emoji.length);
                            });
                          }}
                        />
                      </div>
                      <button
                        type="submit"
                        className="send-button"
                        aria-label={draft.pending ? R.sending : R.send}
                        disabled={
                          !online ||
                          shownDetail?.canWrite !== true ||
                          (!draft.value.trim() && !draft.files.length) ||
                          draft.pending ||
                          draft.uploading
                        }
                      >
                        <PaperPlaneTilt size={24} weight="fill" />
                      </button>
                    </form>
                    <div className={`compose-meta${draftIssue ? ' error-copy' : ''}`} role="status">
                      <span>
                        {draftIssue ||
                          (shownDetail?.canWrite === false
                            ? R.readOnly
                            : !online
                              ? R.offlineHint
                              : draft.uploading
                                ? U.uploading
                                : draft.pending
                                  ? R.sending
                                  : R.keys)}
                      </span>
                      {draft.error && (draft.value.trim() || draft.files.length > 0) && (
                        <button
                          className="secondary-button"
                          disabled={
                            !online ||
                            draft.pending ||
                            draft.uploading ||
                            shownDetail?.canWrite !== true
                          }
                          onClick={() => void send()}
                        >
                          {R.retrySend}
                        </button>
                      )}
                    </div>
                  </div>
                  {objectInfoOpen && selectedChat.kind === 'object' && (
                    <ObjectInfoPanel
                      key={`${owner}:${selectedChat.id}`}
                      epoch={snapshot.epoch}
                      chatId={selectedChat.id}
                      online={online}
                      onClose={() => {
                        setObjectInfoOpen(false);
                        requestAnimationFrame(() => objectInfoButton.current?.focus());
                      }}
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="chat-wall">
                <Empty title={R.pickChat} text={R.pickChatHint} />
              </div>
            )}
          </>
        ) : (
          <>
            {uiError && (
              <div className="banner error-banner" role="status">
                {uiError}
              </div>
            )}
            {gate()}
          </>
        )}
      </main>
    </div>
  );
}

function Empty({
  title,
  text,
  children,
}: {
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="empty-state">
      <SchemaLogo />
      <h1>{title}</h1>
      {text && <p>{text}</p>}
      {children}
    </section>
  );
}
