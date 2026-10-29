import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowSquareOut,
  Bell,
  ChatCircleDots,
  Check,
  GearSix,
  Moon,
  PaperPlaneTilt,
  SignIn,
  SignOut,
  X,
} from '@phosphor-icons/react';
import type { ClientSnapshot, DesktopRequest } from '../shared/desktop';
import { Avatar } from './content';
import { request } from './bridge';
import { chatTitle, timeLabel } from './model';
import { R } from './strings';
import { TimerCard } from './timer';

interface ReplyDraft {
  value: string;
  pending: boolean;
  error: string;
  intent?: { text: string; requestId: string };
}
const freshDraft = (): ReplyDraft => ({ value: '', pending: false, error: '' });

export function TraySurface() {
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const current = useRef<ClientSnapshot | null>(null);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<number, ReplyDraft>>({});
  const draftsRef = useRef(drafts);
  const [heldChat, setHeldChat] = useState<number | null>(null);
  const [writable, setWritable] = useState<{
    chatId: number;
    epoch: number;
    value: boolean;
  } | null>(null);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    const accept = (next: ClientSnapshot) => {
      const before = current.current;
      if (
        before &&
        (next.epoch < before.epoch ||
          (next.epoch === before.epoch && next.revision < before.revision))
      )
        return;
      if (!before || before.epoch !== next.epoch || before.user?.id !== next.user?.id) {
        draftsRef.current = {};
        setDrafts({});
        setHeldChat(null);
        setWritable(null);
        setError('');
        setSent(false);
      }
      current.current = next;
      setSnapshot(next);
      document.documentElement.dataset.theme = next.theme;
    };
    if (!window.teams) {
      setError(R.bridgeError);
      return;
    }
    const unsubscribe = window.teams.subscribe(accept);
    void request({ kind: 'init' }).then((result) => {
      if (result.ok) accept(result.data);
      else setError(result.error);
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void request({ kind: 'window.hide' });
    };
    window.addEventListener('keydown', escape);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const online = snapshot?.connection === 'online';
  const latest = useMemo(() => {
    const chats = snapshot?.chats ?? [];
    if (heldChat !== null) return chats.find((chat) => chat.id === heldChat) ?? null;
    return (
      chats
        .filter(
          (chat) =>
            chat.unread > 0 && chat.last !== null && chat.last.authorId !== snapshot?.user?.id,
        )
        .sort((a, b) => Date.parse(b.last?.at ?? '') - Date.parse(a.last?.at ?? ''))[0] ?? null
    );
  }, [snapshot?.chats, snapshot?.user?.id, heldChat]);
  const draft = latest ? (drafts[latest.id] ?? freshDraft()) : freshDraft();
  const canWrite =
    online &&
    latest !== null &&
    writable?.chatId === latest.id &&
    writable.epoch === snapshot?.epoch &&
    writable.value;

  useEffect(() => {
    setWritable(null);
    const captured = current.current;
    const chatId = latest?.id;
    if (
      !captured?.user ||
      captured.epoch !== snapshot?.epoch ||
      captured.connection !== 'online' ||
      chatId === undefined
    )
      return;
    let active = true;
    void request({ kind: 'chat.detail', epoch: captured.epoch, chatId }).then((result) => {
      if (!active || current.current?.epoch !== captured.epoch) return;
      if (result.ok) setWritable({ chatId, epoch: captured.epoch, value: result.data.canWrite });
    });
    return () => {
      active = false;
    };
  }, [latest?.id, snapshot?.epoch, online]);

  function patch(chatId: number, edit: (before: ReplyDraft) => ReplyDraft) {
    const next = {
      ...draftsRef.current,
      [chatId]: edit(draftsRef.current[chatId] ?? freshDraft()),
    };
    draftsRef.current = next;
    setDrafts(next);
  }
  async function act(action: DesktopRequest, hide = true) {
    if ('epoch' in action && current.current?.epoch !== action.epoch) return;
    const result = await request(action);
    if ('epoch' in action && current.current?.epoch !== action.epoch) return;
    if (!result.ok) setError(result.error);
    else if (hide) void request({ kind: 'window.hide' });
  }
  async function send() {
    const captured = current.current;
    const chat = latest;
    if (!captured?.user || captured.epoch !== snapshot?.epoch || !chat || !canWrite) return;
    const value = draftsRef.current[chat.id] ?? freshDraft();
    const text = value.value.trim();
    if (!text || text.length > 4000 || value.pending) return;
    const intent =
      value.intent?.text === text ? value.intent : { text, requestId: crypto.randomUUID() };
    setHeldChat(chat.id);
    patch(chat.id, (before) => ({ ...before, intent, pending: true, error: '' }));
    const result = await request({
      kind: 'chat.send',
      epoch: captured.epoch,
      chatId: chat.id,
      text,
      requestId: intent.requestId,
    });
    if (current.current?.epoch !== captured.epoch || current.current.user?.id !== captured.user.id)
      return;
    if (result.ok) {
      patch(chat.id, () => freshDraft());
      setHeldChat(null);
      setSent(true);
    } else
      patch(chat.id, (before) => ({
        ...before,
        pending: false,
        error: result.uncertain ? R.uncertain : result.error,
      }));
  }
  const focus =
    snapshot?.focus.until && Date.parse(snapshot.focus.until) > Date.now()
      ? snapshot.focus.until
      : null;
  return (
    <main className="tray-root" data-surface="tray">
      <header className="tray-user">
        <Avatar name={snapshot?.user?.shortName ?? R.appName} id={snapshot?.user?.id ?? 0} />
        <div>
          <b>{snapshot?.user?.shortName ?? R.appName}</b>
          <small>
            <i className={`status-dot${online ? '' : ' offline'}`} />
            {online
              ? R.online
              : snapshot?.connection === 'signedOut'
                ? R.signedOut
                : snapshot?.connection === 'connecting'
                  ? R.connecting
                  : R.offline}
          </small>
        </div>
        <button
          className="icon-button"
          aria-label={R.closeMenu}
          onClick={() => void act({ kind: 'window.hide' }, false)}
        >
          <X size={18} />
        </button>
      </header>
      {error && (
        <div className="banner error-banner" role="status">
          {error}
        </div>
      )}
      {snapshot?.user ? (
        <>
          <TimerCard
            snapshot={snapshot}
            onOpen={(mode) => void act({ kind: 'timer.open', epoch: snapshot.epoch, mode })}
          />
          <section className="tray-focus">
            <div>
              <Moon size={17} weight="duotone" />
              <b>{focus ? R.focus : R.focusDisabled}</b>
            </div>
            <p>{focus ? R.focusUntil(timeLabel(focus)) : R.focusHint}</p>
            <button
              disabled={!online}
              onClick={() =>
                void act(
                  { kind: 'focus.set', epoch: snapshot.epoch, minutes: focus ? 0 : 30 },
                  false,
                )
              }
            >
              {focus ? R.focusOff : R.focus30}
            </button>
            {!focus && (
              <button
                disabled={!online}
                onClick={() =>
                  void act({ kind: 'focus.set', epoch: snapshot.epoch, minutes: 60 }, false)
                }
              >
                {R.focus60}
              </button>
            )}
          </section>
          <button
            className="tray-item"
            onClick={() => void act({ kind: 'window.show', epoch: snapshot.epoch })}
          >
            <ChatCircleDots size={20} weight="duotone" />
            <span>{R.openApp}</span>
            {(snapshot.unread ?? 0) > 0 && <b className="unread-badge">{snapshot.unread}</b>}
          </button>
          <button
            className="tray-item"
            onClick={() =>
              void act({ kind: 'window.show', epoch: snapshot.epoch, target: 'events' })
            }
          >
            <Bell size={20} weight="duotone" />
            <span>{R.events}</span>
            {snapshot.notificationUnread > 0 && (
              <b className="unread-badge">{snapshot.notificationUnread}</b>
            )}
          </button>
          <label className="tray-item">
            <GearSix size={20} weight="duotone" />
            <span>{R.theme}</span>
            <select
              aria-label={R.theme}
              value={snapshot.themePreference}
              onChange={(event) =>
                void act(
                  { kind: 'theme', mode: event.target.value as 'system' | 'light' | 'dark' },
                  false,
                )
              }
            >
              <option value="system">{R.themeSystem}</option>
              <option value="light">{R.themeLight}</option>
              <option value="dark">{R.themeDark}</option>
            </select>
          </label>
        </>
      ) : (
        <button className="tray-item" onClick={() => void act({ kind: 'login' })}>
          <SignIn size={20} weight="duotone" />
          <span>{R.login}</span>
        </button>
      )}
      <button
        className="tray-item"
        disabled={!snapshot?.user}
        onClick={() =>
          snapshot && void act({ kind: 'open.site', epoch: snapshot.epoch, path: '/my' })
        }
      >
        <ArrowSquareOut size={20} weight="duotone" />
        <span>{R.myTasks}</span>
      </button>
      {latest?.last && (
        <section className="tray-new">
          <header>
            <ChatCircleDots size={15} weight="duotone" />
            <b>{R.newMessage}</b>
            <button
              onClick={() =>
                snapshot &&
                void act({
                  kind: 'window.show',
                  epoch: snapshot.epoch,
                  chatId: latest.id,
                  messageId: latest.last?.id,
                })
              }
            >
              {R.open}
            </button>
          </header>
          <div className="tray-new-body">
            <Avatar
              name={chatTitle(latest)}
              id={latest.peer?.id ?? latest.id}
              object={latest.kind === 'object'}
              small
            />
            <div>
              <b>{chatTitle(latest)}</b>
              <p>{latest.last.deleted ? R.deleted : latest.last.preview}</p>
            </div>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              rows={1}
              aria-label={R.quickReply}
              placeholder={R.quickReply}
              value={draft.value}
              maxLength={4000}
              disabled={!canWrite || draft.pending}
              onChange={(event) => {
                if (current.current?.epoch !== snapshot?.epoch) return;
                setHeldChat(latest.id);
                setSent(false);
                const value = event.target.value;
                patch(latest.id, (before) => ({
                  ...before,
                  value,
                  error: '',
                  ...(before.intent?.text !== value.trim() && { intent: undefined }),
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
            />
            <button
              className="send-button"
              type="submit"
              aria-label={draft.pending ? R.sending : R.send}
              disabled={!canWrite || draft.pending || !draft.value.trim()}
            >
              <PaperPlaneTilt size={18} weight="fill" />
            </button>
          </form>
          {draft.error && (
            <p className="tray-reply-status error-copy" role="status">
              {draft.error}
            </p>
          )}
        </section>
      )}
      {sent && (
        <div className="inline-status" role="status">
          <Check size={15} />
          {R.sent}
        </div>
      )}
      <footer className="tray-bottom">
        <small>{R.version(snapshot?.appVersion ?? '', snapshot?.serverVersion ?? '')}</small>
        <button className="tray-item" onClick={() => void act({ kind: 'app.quit' }, false)}>
          <SignOut size={20} weight="duotone" />
          <span>{R.quit}</span>
        </button>
      </footer>
    </main>
  );
}
