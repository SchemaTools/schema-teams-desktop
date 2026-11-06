// Окно «Новый чат» (по замечаниям руководителя 06.11.2026) — по образцу сайта Teams
// («Написать коллеге» и «Новая группа»): поиск коллеги по фамилии; «Личный» — щелчок
// по коллеге открывает личный чат (уже есть — сервер вернёт прежний), «Группа» — несколько
// коллег и название. Чаты объектов создаются на сайте. Запросы — через главный процесс.
import { Check, MessageSquarePlus, Search, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatSummary, PersonRef } from '../shared/client';
import { CHAT_GROUP_MAX, CHAT_TITLE_MAX } from '../shared/client';
import { peopleServerQuery, rankPeople } from '../shared/newChat';
import { request } from './bridge';
import { Avatar } from './content';
import { N } from './newChatStrings';
import './newChat.css';

type Mode = 'direct' | 'group';

/** Набранное уходит на сервер с небольшой задержкой (как на сайте — 200 мс). */
function usePeople(epoch: number, query: string, online: boolean) {
  const [people, setPeople] = useState<PersonRef[] | null>(null);
  const [error, setError] = useState('');
  const serverQuery = peopleServerQuery(query);
  useEffect(() => {
    if (!online) return;
    let alive = true;
    const timer = setTimeout(() => {
      void request({ kind: 'chat.people', epoch, q: serverQuery }).then((result) => {
        if (!alive) return;
        if (result.ok) {
          setPeople(result.data);
          setError('');
        } else setError(result.error);
      });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [epoch, serverQuery, online]);
  return { people, error };
}

export function NewChatDialog({
  epoch,
  ownId,
  online,
  onClose,
  onOpened,
}: {
  epoch: number;
  ownId: number;
  online: boolean;
  onClose: () => void;
  onOpened: (chat: ChatSummary) => void;
}) {
  const [mode, setMode] = useState<Mode>('direct');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<PersonRef[]>([]);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState('');
  const busy = useRef(false);
  const alive = useRef(true);
  // один ключ на одну группу: повтор «Создать» до ответа не создаст вторую
  const groupKey = useRef(crypto.randomUUID());
  const search = useRef<HTMLInputElement>(null);
  const { people, error } = usePeople(epoch, query, online);
  const rows = useMemo(
    () =>
      rankPeople(
        (people ?? []).filter((p) => p.id !== ownId),
        query,
      ),
    [people, query, ownId],
  );

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      alive.current = false;
      previous?.focus();
    };
  }, []);
  // состав или название поменялись — это уже другая группа
  useEffect(() => {
    groupKey.current = crypto.randomUUID();
  }, [title, picked]);

  async function openDirect(person: PersonRef) {
    if (busy.current || !online) return;
    busy.current = true;
    setPending(true);
    setProblem('');
    const result = await request({ kind: 'chat.direct', epoch, userId: person.id });
    if (!alive.current) return;
    busy.current = false;
    setPending(false);
    if (result.ok) onOpened(result.data);
    else setProblem(result.error);
  }
  async function createGroup() {
    if (busy.current || !online) return;
    if (!title.trim()) return setProblem(N.groupNeedTitle);
    if (!picked.length) return setProblem(N.groupNeedPeople);
    busy.current = true;
    setPending(true);
    setProblem('');
    const result = await request({
      kind: 'chat.group',
      epoch,
      title: title.trim(),
      userIds: picked.map((p) => p.id),
      requestId: groupKey.current,
    });
    if (!alive.current) return;
    busy.current = false;
    setPending(false);
    if (result.ok) onOpened(result.data);
    else
      setProblem(
        result.uncertain
          ? N.groupUncertain
          : result.code === 'forbidden'
            ? N.groupForbidden
            : result.error,
      );
  }
  function toggle(person: PersonRef) {
    setProblem('');
    setPicked((current) =>
      current.some((p) => p.id === person.id)
        ? current.filter((p) => p.id !== person.id)
        : current.length >= CHAT_GROUP_MAX - 1
          ? current
          : [...current, person],
    );
  }
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) {
      event.stopPropagation();
      onClose();
    }
    if (event.key === 'Tab') {
      const nodes = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled)',
          ),
        ).filter((n) => n.getClientRects().length > 0),
        first = nodes[0],
        last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }
  const isPicked = (id: number) => picked.some((p) => p.id === id);

  return (
    <div className="new-chat-backdrop" onKeyDown={keys}>
      <section
        className="new-chat-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
      >
        <header>
          <MessageSquarePlus size={22} />
          <div>
            <h2 id="new-chat-title">{N.newChat}</h2>
            <small>{N.newChatHint}</small>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={N.close}
            disabled={pending}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </header>
        <div className="new-chat-body">
          <div className="new-chat-modes" role="tablist" aria-label={N.modes}>
            {(['direct', 'group'] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={mode === value ? 'on' : ''}
                disabled={pending}
                onClick={() => {
                  setMode(value);
                  setProblem('');
                }}
              >
                {value === 'direct' ? <MessageSquarePlus size={16} /> : <Users size={16} />}
                {value === 'direct' ? N.direct : N.group}
              </button>
            ))}
          </div>
          {mode === 'group' && (
            <>
              <label className="new-chat-label" htmlFor="new-chat-name">
                {N.groupName}
              </label>
              <input
                id="new-chat-name"
                className="new-chat-input"
                maxLength={CHAT_TITLE_MAX}
                autoComplete="off"
                value={title}
                disabled={pending}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setProblem('');
                }}
              />
              {picked.length > 0 && (
                <ul className="new-chat-picked" aria-label={N.groupPicked(picked.length)}>
                  {picked.map((person) => (
                    <li key={person.id}>
                      {person.shortName}
                      <button
                        type="button"
                        aria-label={N.unpick(person.shortName)}
                        disabled={pending}
                        onClick={() => toggle(person)}
                      >
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          <label className="new-chat-search">
            <Search size={17} />
            <span className="sr-only">{N.peopleSearch}</span>
            <input
              ref={search}
              type="search"
              aria-label={N.peopleSearch}
              placeholder={N.peopleSearch}
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {mode === 'direct' && <p className="new-chat-hint">{N.directHint}</p>}
          {!online && (
            <p className="new-chat-hint" role="status">
              {N.offline}
            </p>
          )}
          <ul className="new-chat-people" aria-label={N.peopleList}>
            {people === null && !error ? (
              <li className="new-chat-note">{N.peopleLoading}</li>
            ) : rows.length === 0 ? (
              <li className="new-chat-note">{error || N.peopleNone}</li>
            ) : (
              rows.map((person) => (
                <li key={person.id}>
                  <button
                    type="button"
                    className={`new-chat-person${isPicked(person.id) ? ' picked' : ''}`}
                    data-person-id={person.id}
                    disabled={pending || !online}
                    {...(mode === 'group' && { 'aria-pressed': isPicked(person.id) })}
                    onClick={() => (mode === 'direct' ? void openDirect(person) : toggle(person))}
                  >
                    <Avatar name={person.shortName} id={person.id} small presenceId={person.id} />
                    <span className="new-chat-name">{person.shortName}</span>
                    {mode === 'group' && (
                      <span className="new-chat-check" aria-hidden="true">
                        {isPicked(person.id) && <Check size={14} />}
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
          {picked.length >= CHAT_GROUP_MAX - 1 && mode === 'group' && (
            <p className="new-chat-hint">{N.groupMax(CHAT_GROUP_MAX)}</p>
          )}
          {problem && (
            <p className="new-chat-error" role="alert">
              {problem}
            </p>
          )}
        </div>
        {mode === 'group' && (
          <footer>
            <span>{N.groupPicked(picked.length)}</span>
            <button
              type="button"
              className="new-chat-primary"
              disabled={pending || !online}
              onClick={() => void createGroup()}
            >
              <Users size={16} />
              {N.groupCreate}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
