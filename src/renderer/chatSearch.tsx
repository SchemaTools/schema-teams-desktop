import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/client';
import { request } from './bridge';

export function ChatSearch({
  epoch,
  chatId,
  online,
  onJump,
}: {
  epoch: number;
  chatId: number;
  online: boolean;
  onJump: (id: number) => void;
}) {
  const [open, setOpen] = useState(false),
    [q, setQuery] = useState(''),
    [items, setItems] = useState<ChatMessage[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [searched, setSearched] = useState(false);
  const mounted = useRef(true),
    ticket = useRef(0),
    flight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ticket.current++;
    };
  }, []);
  function close() {
    ticket.current++;
    setOpen(false);
    setQuery('');
    setItems([]);
    setError('');
    setBusy(false);
    setSearched(false);
    flight.current = false;
  }
  async function search() {
    if (!online || flight.current || q.trim().length < 2) return;
    const own = ++ticket.current;
    flight.current = true;
    setBusy(true);
    setError('');
    const result = await request({ kind: 'chat.search', epoch, chatId, q: q.trim() });
    if (!mounted.current || ticket.current !== own) return;
    flight.current = false;
    setBusy(false);
    setSearched(true);
    if (result.ok) setItems(result.data);
    else {
      setError(result.error);
      setItems([]);
    }
  }
  return (
    <div className="chat-search">
      <button
        type="button"
        className="icon-button"
        aria-label="Поиск в чате"
        aria-expanded={open}
        disabled={!online}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <MagnifyingGlass size={20} />
      </button>
      {open && (
        <section className="chat-search-panel" aria-label="Поиск сообщений">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <input
              autoFocus
              aria-label="Текст поиска в чате"
              placeholder="Не менее двух знаков"
              maxLength={100}
              value={q}
              onChange={(event) => {
                ticket.current++;
                flight.current = false;
                setBusy(false);
                setQuery(event.target.value);
                setItems([]);
                setSearched(false);
                setError('');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') close();
              }}
            />
            <button type="submit" disabled={busy || !online || q.trim().length < 2}>
              Найти
            </button>
            <button type="button" aria-label="Закрыть поиск" onClick={close}>
              <X size={17} />
            </button>
          </form>
          {busy && <p role="status">Поиск…</p>}
          {error && <p role="alert">{error}</p>}
          <div className="chat-search-results">
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  onJump(item.id);
                  close();
                }}
              >
                <strong>{item.author?.shortName ?? 'Служебное сообщение'}</strong>
                <span>{item.text || 'Вложение'}</span>
              </button>
            ))}
          </div>
          {searched && !error && !busy && (
            <p role="status">
              {items.length
                ? `Найдено: ${items.length}${items.length === 30 ? ' (последние 30)' : ''}`
                : 'Сообщения не найдены'}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
