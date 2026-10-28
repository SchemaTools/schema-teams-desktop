import { ArrowSquareOut, Check, Checks, File, FolderOpen } from '@phosphor-icons/react';
import type { ChatMessage } from '../shared/client';
import { request } from './bridge';
import { colorClass, initials, timeLabel } from './model';
import { R } from './strings';

export function SchemaLogo({ className = '' }: { className?: string }) {
  return (
    <svg className={`schema-logo ${className}`} viewBox="0 0 22 22" aria-hidden="true">
      <rect x="6" y="1" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="1" y="6" width="15" height="15" fill="currentColor" opacity=".92" />
    </svg>
  );
}

export function Avatar({
  name,
  id,
  object = false,
  bot = false,
  small = false,
}: {
  name: string;
  id: number;
  object?: boolean;
  bot?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={`avatar ${colorClass(id)}${object ? ' object-avatar' : ''}${bot ? ' bot-avatar' : ''}${small ? ' small' : ''}`}
      aria-hidden="true"
    >
      {bot ? <SchemaLogo /> : initials(name)}
    </span>
  );
}

function MessageText({
  text,
  epoch,
  onError,
}: {
  text: string;
  epoch: number;
  onError: (message: string) => void;
}) {
  const openUrl = async (url: string) => {
    const result = await request({ kind: 'open.link', epoch, url });
    if (!result.ok) onError(result.error);
  };
  const pathAction = async (path: string, reveal: boolean) => {
    const result = await request({ kind: 'open.path', epoch, path, reveal });
    if (!result.ok) onError(result.error);
    else if (result.data === 'blocked') onError(R.pathBlocked);
  };
  return (
    <div className="message-text">
      {text.split('\n').map((line, index) => {
        const unc = /\\\\[^\\\s]+\\[^\r\n]+/.exec(line);
        if (unc) {
          const prefix = line.slice(0, unc.index);
          const path = unc[0];
          return (
            <div key={index}>
              {prefix}
              <div className="path-card" aria-label={R.path}>
                <FolderOpen size={18} weight="duotone" />
                <code>{path}</code>
                <button type="button" onClick={() => void pathAction(path, false)}>
                  {R.open}
                </button>
                <button type="button" onClick={() => void pathAction(path, true)}>
                  {R.reveal}
                </button>
              </div>
            </div>
          );
        }
        const pieces = line.split(/(https?:\/\/[^\s<>"']+)/g);
        return (
          <span key={index}>
            {pieces.map((piece, part) =>
              /^https?:\/\//.test(piece) ? (
                <a
                  key={part}
                  href={piece}
                  onClick={(event) => {
                    event.preventDefault();
                    void openUrl(piece);
                  }}
                >
                  {piece}
                </a>
              ) : (
                piece
              ),
            )}
            {index < text.split('\n').length - 1 ? '\n' : ''}
          </span>
        );
      })}
    </div>
  );
}

export function MessageBubble({
  message,
  epoch,
  ownId,
  read,
  onError,
}: {
  message: ChatMessage;
  epoch: number;
  ownId: number;
  read: boolean;
  onError: (message: string) => void;
}) {
  const own = message.author?.id === ownId;
  const name = message.author?.shortName ?? R.unknownAuthor;
  const hasRich =
    !message.deleted &&
    (message.files.length > 0 ||
      message.cards.length > 0 ||
      message.sticker !== null ||
      message.poll !== null ||
      message.reactions.length > 0);
  const openWeb = async () => {
    const result = await request({
      kind: 'open.site',
      epoch,
      path: `/chat/${message.chatId}?m=${message.id}`,
    });
    if (!result.ok) onError(result.error);
  };
  return (
    <article
      className={`message-row${own ? ' outgoing' : ''}`}
      data-message-id={message.id}
      aria-label={`${name}, ${timeLabel(message.at)}`}
    >
      {!own && <Avatar name={name} id={message.author?.id ?? 0} small />}
      <div className="message-bubble">
        {!own && <span className="message-author">{name}</span>}
        {!message.deleted && message.replyTo && (
          <blockquote className="message-quote">
            <b>{message.replyTo.authorShortName ?? R.unknownAuthor}</b>
            {message.replyTo.deleted ? R.deleted : message.replyTo.preview}
          </blockquote>
        )}
        <MessageText
          text={message.deleted ? R.deleted : message.text}
          epoch={epoch}
          onError={onError}
        />
        {!message.deleted &&
          message.files.map((file) => (
            <div key={file.fileId} className="attachment-meta">
              <File size={20} weight="duotone" />
              <span>
                {file.fileName}
                <small>
                  {new Intl.NumberFormat('ru-RU', {
                    style: 'unit',
                    unit: 'kilobyte',
                    maximumFractionDigits: 1,
                  }).format(file.size / 1024)}
                </small>
              </span>
            </div>
          ))}
        {hasRich && (
          <div className="fallback-content">
            {R.richMessage}
            <br />
            <button type="button" onClick={() => void openWeb()}>
              <ArrowSquareOut size={14} weight="duotone" />
              {R.openMessageWeb}
            </button>
          </div>
        )}
        <footer className="message-footer">
          {message.editedAt && <span>{R.edited}</span>}
          <time dateTime={message.at}>{timeLabel(message.at)}</time>
          {own &&
            (read ? (
              <Checks size={15} aria-label={R.read} />
            ) : (
              <Check size={15} aria-label={R.sent} />
            ))}
        </footer>
      </div>
    </article>
  );
}
