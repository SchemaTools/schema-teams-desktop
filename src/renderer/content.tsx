import { ArrowSquareOut, Check, Checks, File, FolderOpen } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatFile, ChatMessage } from '../shared/client';
import { request } from './bridge';
import { colorClass, initials, timeLabel } from './model';
import { R } from './strings';

const previewQueue: { current: () => boolean; run: () => Promise<void> }[] = [];
let activePreviews = 0;
function drainPreviews(): void {
  while (activePreviews < 2 && previewQueue.length) {
    const job = previewQueue.shift();
    if (!job?.current()) continue;
    activePreviews++;
    void job.run().finally(() => {
      activePreviews--;
      drainPreviews();
    });
  }
}

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
  const pathAction = async (path: string) => {
    const result = await request({ kind: 'open.path', epoch, path, reveal: true });
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
                <button type="button" onClick={() => void pathAction(path)}>
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

function ImagePreview({ url, name, close }: { url: string; name: string; close: () => void }) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="attachment-dialog"
      aria-label={name}
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header>
        <b>{name}</b>
        <button type="button" onClick={close} autoFocus>
          {R.closePreview}
        </button>
      </header>
      <img src={url} alt={name} />
    </dialog>
  );
}

function Attachment({
  file,
  epoch,
  chatId,
  messageId,
}: {
  file: ChatFile;
  epoch: number;
  chatId: number;
  messageId: number;
}) {
  const identity = `${epoch}:${chatId}:${messageId}:${file.fileId}`;
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  const card = useRef<HTMLElement | null>(null);
  const flight = useRef<string | null>(null);
  const previewFlight = useRef<{ identity: string; zoom: boolean }>();
  const [busyFor, setBusyFor] = useState<string>();
  const [feedback, setFeedback] = useState<{ identity: string; text: string; error: boolean }>();
  const [preview, setPreview] = useState<{ identity: string; url: string }>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewLoading, setPreviewLoading] = useState<string>();
  const [nearViewport, setNearViewport] = useState(false);
  const [enlarged, setEnlarged] = useState<{ identity: string; url: string }>();
  const raster = file.isImage && /^image\/(?:png|jpeg|gif|webp)$/i.test(file.mime);
  const rasterCurrent = useRef(raster);
  rasterCurrent.current = raster;
  const busy = busyFor === identity;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!raster || !card.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [raster]);
  const loadPreview = useCallback(
    (zoom: boolean) => {
      if (!rasterCurrent.current) return;
      const pending = previewFlight.current;
      if (pending?.identity === identity) {
        if (zoom) pending.zoom = true;
        return;
      }
      const job = { identity, zoom };
      previewFlight.current = job;
      setPreviewLoading(identity);
      setPreviewError(undefined);
      const relevant = () =>
        mounted.current &&
        rasterCurrent.current &&
        current.current === identity &&
        previewFlight.current === job;
      previewQueue.push({
        current: relevant,
        run: async () => {
          const result = await request({
            kind: 'file.preview',
            epoch,
            chatId,
            messageId,
            fileId: file.fileId,
          });
          if (!relevant()) return;
          previewFlight.current = undefined;
          setPreviewLoading(undefined);
          if (
            result.ok &&
            /^schema-attachment:\/\/preview\/[A-Za-z0-9_-]+$/.test(result.data.url)
          ) {
            setPreview({ identity, url: result.data.url });
            if (job.zoom) setEnlarged({ identity, url: result.data.url });
          } else {
            setPreviewError(identity);
          }
        },
      });
      drainPreviews();
    },
    [epoch, chatId, messageId, file.fileId, identity],
  );
  useEffect(() => {
    if (raster && nearViewport) loadPreview(false);
  }, [raster, nearViewport, loadPreview]);
  const act = async (action: 'save' | 'open' | 'reveal') => {
    if (flight.current === identity) return;
    flight.current = identity;
    setBusyFor(identity);
    setFeedback(undefined);
    const result = await request({
      kind: 'file.action',
      epoch,
      chatId,
      messageId,
      fileId: file.fileId,
      action,
    });
    if (!mounted.current || current.current !== identity) return;
    flight.current = null;
    setBusyFor(undefined);
    if (!result.ok) setFeedback({ identity, text: result.error, error: true });
    else if (result.data === 'blocked')
      setFeedback({ identity, text: R.attachmentBlocked, error: true });
    else if (result.data === 'saved')
      setFeedback({ identity, text: R.attachmentSaved, error: false });
  };
  const visiblePreview = preview?.identity === identity ? preview.url : null;
  return (
    <section
      ref={card}
      className="attachment-card"
      data-file-id={file.fileId}
      aria-label={file.fileName}
    >
      {raster && visiblePreview && previewError !== identity && (
        <button
          type="button"
          className="attachment-preview-button"
          aria-label={R.enlargeImage(file.fileName)}
          disabled={previewLoading === identity}
          onClick={() => loadPreview(true)}
        >
          <img
            className="attachment-preview"
            src={visiblePreview}
            alt={file.fileName}
            loading="lazy"
            onError={() => setPreviewError(identity)}
          />
        </button>
      )}
      {enlarged?.identity === identity && previewError !== identity && (
        <ImagePreview
          url={enlarged.url}
          name={file.fileName}
          close={() => setEnlarged(undefined)}
        />
      )}
      {raster && (!visiblePreview || previewError === identity || previewLoading === identity) && (
        <span className="attachment-preview-state">
          {previewError === identity ? R.attachmentPreviewUnavailable : R.attachmentLoading}
        </span>
      )}
      {raster && previewError === identity && (
        <button
          type="button"
          className="attachment-preview-retry"
          disabled={previewLoading === identity}
          onClick={() => loadPreview(false)}
        >
          {R.attachmentPreviewRetry}
        </button>
      )}
      <div className="attachment-meta">
        <File size={20} weight="duotone" aria-hidden="true" />
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
      <div className="attachment-actions" aria-busy={busy}>
        <button type="button" disabled={busy} onClick={() => void act('save')}>
          {R.download}
        </button>
        <button type="button" disabled={busy} onClick={() => void act('open')}>
          {R.open}
        </button>
        <button type="button" disabled={busy} onClick={() => void act('reveal')}>
          {R.reveal}
        </button>
      </div>
      {busy && <span className="attachment-feedback">{R.attachmentLoading}</span>}
      {feedback?.identity === identity && (
        <span className="attachment-feedback" role={feedback.error ? 'alert' : 'status'}>
          {feedback.text}
        </span>
      )}
    </section>
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
    (message.cards.length > 0 ||
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
            <Attachment
              key={`${epoch}:${message.chatId}:${message.id}:${file.fileId}`}
              file={file}
              epoch={epoch}
              chatId={message.chatId}
              messageId={message.id}
            />
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
