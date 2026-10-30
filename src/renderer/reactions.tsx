import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatReaction } from '../shared/client';
import { REACTION_KINDS, type ReactionKind } from '../shared/client';
import { request } from './bridge';
import { reactionAssets } from './reactionAssets';
import { ReactionText } from './reactionStrings';
import './reactions.css';

const QUICK_KINDS = ['like', 'heart', 'fire', 'done', 'look', 'party'] as const;
type Kind = ReactionKind;
interface Confirmed {
  identity: string;
  source: ChatReaction[];
  reactions: ChatReaction[];
}
interface Props {
  epoch: number;
  chatId: number;
  messageId: number;
  ownId: number;
  reactions: ChatReaction[];
  enabled: boolean;
  onError: (message: string) => void;
  onChange?: (messageId: number, reactions: ChatReaction[]) => void;
}

function mine(reactions: ChatReaction[], kind: Kind, ownId: number): boolean {
  return reactions.some((r) => r.kind === kind && r.users.some((user) => user.id === ownId));
}

export function MessageReactions({
  epoch,
  chatId,
  messageId,
  ownId,
  reactions,
  enabled,
  onError,
  onChange,
}: Props) {
  const identity = `${epoch}:${chatId}:${messageId}:${ownId}`;
  const root = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(false);
  const [panelTop, setPanelTop] = useState<number | null>(null);
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  const flight = useRef<{ identity: string; kind: Kind }>();
  const [confirmed, setConfirmed] = useState<Confirmed>();
  const [more, setMore] = useState<string>();
  useEffect(() => {
    if (more !== identity) return;
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setMore(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMore(undefined);
        root.current?.querySelector<HTMLButtonElement>('.reaction-more')?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [identity, more]);
  const [pending, setPending] = useState<{ identity: string; kind: Kind }>();
  const [burst, setBurst] = useState<{ identity: string; kind: Kind; key: number }>();
  const [error, setError] = useState<{ identity: string; text: string }>();
  const values =
    confirmed?.identity === identity && confirmed.source === reactions
      ? confirmed.reactions
      : reactions;
  const busy = pending?.identity === identity;
  useLayoutEffect(() => {
    const row = root.current?.closest('.message-row');
    const panel = root.current?.querySelector<HTMLElement>('.message-quick-reactions');
    const bubble = root.current?.closest('.message-bubble');
    const viewport = root.current?.closest('.messages-scroll');
    if (!row || !panel || !bubble || !viewport) return;
    const place = () => {
      const anchor = bubble.getBoundingClientRect(),
        view = viewport.getBoundingClientRect(),
        height = panel.offsetHeight;
      const needsBelow = anchor.top - height - 6 < view.top;
      setBelow(needsBelow);
      setPanelTop(
        needsBelow && anchor.bottom + height + 6 > view.bottom
          ? Math.max(view.top + 4, view.bottom - height - 4) - anchor.top
          : null,
      );
    };
    row.addEventListener('pointerenter', place);
    row.addEventListener('pointermove', place);
    row.addEventListener('focusin', place);
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    observer.observe(bubble);
    observer.observe(viewport);
    place();
    return () => {
      row.removeEventListener('pointerenter', place);
      row.removeEventListener('pointermove', place);
      row.removeEventListener('focusin', place);
      observer.disconnect();
    };
  }, [identity, enabled]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const toggle = async (kind: Kind) => {
    if (!enabled || flight.current?.identity === identity) return;
    const job = { identity, kind };
    const remove = mine(values, kind, ownId);
    flight.current = job;
    setPending(job);
    setError(undefined);
    const result = await request({
      kind: 'chat.reaction',
      epoch,
      chatId,
      messageId,
      reaction: kind,
      remove,
    });
    if (!mounted.current || current.current !== identity || flight.current !== job) return;
    flight.current = undefined;
    setPending(undefined);
    if (!result.ok) {
      setError({ identity, text: result.error });
      onError(result.error);
      return;
    }
    setConfirmed({ identity, source: reactions, reactions: result.data });
    onChange?.(messageId, result.data);
    if (!remove && mine(result.data, kind, ownId)) {
      setBurst({ identity, kind, key: Date.now() });
    }
  };

  return (
    <div ref={root} className="message-reactions" data-message-reactions={messageId}>
      {enabled && (
        <div
          className={`message-quick-reactions${below ? ' below-message' : ''}${more === identity ? ' expanded' : ''}`}
          style={panelTop === null ? undefined : { top: panelTop, bottom: 'auto' }}
          role="group"
          aria-label={ReactionText.quick}
        >
          {(more === identity
            ? [...QUICK_KINDS, 'laugh' as const, 'question' as const]
            : QUICK_KINDS
          ).map((kind) => {
            const active = mine(values, kind, ownId);
            const name = ReactionText.names[kind];
            return (
              <button
                type="button"
                key={kind}
                className="reaction-choice"
                data-reaction-action={kind}
                disabled={busy}
                aria-label={active ? ReactionText.remove(name) : ReactionText.add(name)}
                aria-pressed={active}
                title={name}
                onClick={() => void toggle(kind)}
              >
                <img src={reactionAssets[kind]} alt="" draggable={false} />
              </button>
            );
          })}
          <button
            type="button"
            className="reaction-choice reaction-more"
            aria-label="Другие реакции"
            aria-expanded={more === identity}
            onClick={() => setMore(more === identity ? undefined : identity)}
          >
            Ещё
          </button>
        </div>
      )}
      <div className="message-reaction-badges" role="group" aria-label={ReactionText.label}>
        {REACTION_KINDS.map((kind) => {
          const reaction = values.find((r) => r.kind === kind);
          if (!reaction?.users.length) return null;
          const active = mine(values, kind, ownId);
          const name = ReactionText.names[kind];
          const animated = burst?.identity === identity && burst.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              className={`reaction-badge${active ? ' own-reaction' : ''}`}
              data-reaction-kind={kind}
              data-reaction-count={reaction.users.length}
              disabled={!enabled || busy}
              aria-pressed={active}
              aria-label={`${active ? ReactionText.remove(name) : ReactionText.add(name)}. ${ReactionText.count(name, reaction.users.length)}`}
              title={reaction.users.map((user) => user.shortName).join(', ')}
              onClick={() => void toggle(kind)}
            >
              <img
                key={animated ? `image-${burst.key}` : 'still'}
                className={animated ? 'reaction-pulse' : undefined}
                src={reactionAssets[kind]}
                alt=""
                draggable={false}
              />
              <span>{reaction.users.length}</span>
              {animated && (
                <span key={`ring-${burst.key}`} className="reaction-ring" aria-hidden="true" />
              )}
            </button>
          );
        })}
      </div>
      {busy && (
        <span className="reaction-pending" role="status">
          {ReactionText.pending}
        </span>
      )}
      {error?.identity === identity && (
        <span className="reaction-error" role="alert">
          {error.text}
        </span>
      )}
    </div>
  );
}
