import { Reply, Pencil, Pin, Trash, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/client';
import { request } from './bridge';
import './messageActions.css';

export function MessageActions({
  message,
  epoch,
  ownId,
  canWrite,
  canPin,
  pinned,
  onReply,
  onChange,
  onPin,
}: {
  message: ChatMessage;
  epoch: number;
  ownId: number;
  canWrite: boolean;
  canPin: boolean;
  pinned: boolean;
  onReply: () => void;
  onChange: (message: ChatMessage) => void;
  onPin: () => void;
}) {
  const identity = `${epoch}:${message.chatId}:${message.id}:${ownId}`;
  const latest = useRef(identity);
  latest.current = identity;
  const mounted = useRef(true),
    flight = useRef(false);
  const [mode, setMode] = useState<'edit' | 'delete' | null>(null),
    [text, setText] = useState(message.text),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const editable = canWrite && message.canEdit && message.author?.id === ownId && !message.deleted;
  async function mutate(kind: 'edit' | 'delete' | 'pin') {
    if (
      flight.current ||
      !canWrite ||
      message.deleted ||
      (kind !== 'pin' && !editable) ||
      (kind === 'pin' && !canPin)
    )
      return;
    flight.current = true;
    setBusy(true);
    setError('');
    const scope = { epoch, chatId: message.chatId, messageId: message.id };
    const result = await request(
      kind === 'edit'
        ? { kind: 'chat.edit', ...scope, text }
        : kind === 'delete'
          ? { kind: 'chat.delete', ...scope }
          : { kind: 'chat.pin', ...scope, messageId: pinned ? null : message.id },
    );
    if (!mounted.current || latest.current !== identity) return;
    flight.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(
        result.uncertain
          ? 'Результат не подтверждён. Проверьте сообщение после восстановления связи перед повтором.'
          : result.error,
      );
      return;
    }
    setMode(null);
    if (kind === 'pin') onPin();
    else if (result.data) onChange(result.data);
  }
  if (message.deleted || !message.author) return null;
  return (
    <>
      <div className="message-actions" role="group" aria-label="Действия с сообщением">
        <button
          type="button"
          disabled={!canWrite || busy}
          title="Ответить с цитатой"
          aria-label="Ответить с цитатой"
          onClick={onReply}
        >
          <Reply size={17} />
        </button>
        {editable && (
          <>
            <button
              type="button"
              disabled={busy}
              title="Изменить сообщение"
              aria-label="Изменить сообщение"
              onClick={() => {
                setText(message.text);
                setError('');
                setMode('edit');
              }}
            >
              <Pencil size={17} />
            </button>
            <button
              type="button"
              disabled={busy}
              title="Удалить сообщение"
              aria-label="Удалить сообщение"
              onClick={() => {
                setError('');
                setMode('delete');
              }}
            >
              <Trash size={17} />
            </button>
          </>
        )}
        {canPin && (
          <button
            type="button"
            disabled={!canWrite || busy}
            title={pinned ? 'Открепить сообщение' : 'Закрепить сообщение'}
            aria-label={pinned ? 'Открепить сообщение' : 'Закрепить сообщение'}
            onClick={() => void mutate('pin')}
          >
            <Pin size={17} />
          </button>
        )}
      </div>
      {mode === 'edit' && editable && (
        <form
          className="message-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate('edit');
          }}
        >
          <label>
            Изменить сообщение
            <textarea
              autoFocus
              className="message-edit-input"
              aria-label="Текст правки"
              value={text}
              maxLength={4000}
              disabled={busy}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy) setMode(null);
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  !event.repeat
                ) {
                  event.preventDefault();
                  void mutate('edit');
                }
              }}
            />
          </label>
          <div>
            <button type="submit" disabled={busy || !text.trim()}>
              Сохранить правку
            </button>
            <button type="button" disabled={busy} onClick={() => setMode(null)}>
              Отмена
            </button>
          </div>
        </form>
      )}
      {mode === 'delete' && editable && (
        <div className="message-delete-confirm" role="group" aria-label="Подтверждение удаления">
          <p>Удалить это сообщение у всех участников? Вложения тоже будут удалены.</p>
          <button type="button" disabled={busy} onClick={() => void mutate('delete')}>
            Удалить у всех
          </button>
          <button type="button" disabled={busy} onClick={() => setMode(null)}>
            Отмена
          </button>
        </div>
      )}
      {busy && <small role="status">Сохранение…</small>}
      {error && (
        <p className="message-action-error" role="alert">
          {error}
          <button type="button" aria-label="Скрыть ошибку действия" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </p>
      )}
    </>
  );
}
