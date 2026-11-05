import { ExternalLink, Check, CheckCheck, File, FolderOpen } from 'lucide-react';
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ChatFile, ChatMessage, ChatReaction } from '../shared/client';
import { request } from './bridge';
import { colorClass, findUncPath, initials, timeLabel } from './model';
import { R } from './strings';
import { MessageReactions } from './reactions';
import { ReactionText } from './reactionStrings';
import { MessageActions } from './messageActions';

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

/** Фото уже не загрузилось в этом окне — не просить снова (буквы до перезапуска окна). */
const failedPhotos = new Set<number>();

export function Avatar({
  name,
  id,
  photo = null,
  object = false,
  bot = false,
  small = false,
}: {
  name: string;
  id: number;
  /** Фото профиля или логотип бюро (`photoFileId`); null — буквы. */
  photo?: number | null;
  object?: boolean;
  bot?: boolean;
  small?: boolean;
}) {
  const [failed, setFailed] = useState(() => photo !== null && failedPhotos.has(photo));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setFailed(photo !== null && failedPhotos.has(photo));
    setLoaded(false);
  }, [photo]);
  const showPhoto = photo !== null && !failed;
  return (
    <span
      className={`avatar ${colorClass(id)}${object ? ' object-avatar' : ''}${bot ? ' bot-avatar' : ''}${small ? ' small' : ''}${showPhoto && loaded ? ' with-photo' : ''}`}
      aria-hidden="true"
    >
      {/* буквы видны, пока фото грузится или если его нет */}
      {!(showPhoto && loaded) && (bot ? <SchemaLogo /> : initials(name))}
      {showPhoto && (
        <img
          className="avatar-photo"
          src={`schema-attachment://avatar/${photo}`}
          alt=""
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => {
            failedPhotos.add(photo);
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

/** Эмодзи бюро для ленты: код без двоеточий → ид файла картинки. */
export const BureauEmoji = createContext<ReadonlyMap<string, number>>(new Map());
/** Код своего эмодзи в тексте — как на сервере (`CHAT_EMOJI_IN_TEXT`). */
const EMOJI_CODE = /:([\p{L}\p{N}_]{2,32}):/gu;

/** Коды известных эмодзи бюро — картинкой; незнакомый код остаётся текстом. */
export function withEmoji(piece: string, emoji: ReadonlyMap<string, number>): ReactNode[] {
  if (!emoji.size || !piece.includes(':')) return [piece];
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of piece.matchAll(EMOJI_CODE)) {
    const fileId = emoji.get(match[1] ?? '');
    if (fileId === undefined) continue;
    if (match.index > last) out.push(piece.slice(last, match.index));
    out.push(
      <img
        key={`${match.index}:${match[0]}`}
        className="bureau-emoji"
        src={`schema-attachment://sticker/${fileId}`}
        alt={match[0]}
        title={match[0]}
        draggable={false}
      />,
    );
    last = match.index + match[0].length;
  }
  if (last < piece.length) out.push(piece.slice(last));
  return out;
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
  const emoji = useContext(BureauEmoji);
  const links = (line: string) =>
    line.split(/(https?:\/\/[^\s<>"']+)/g).map((piece, part) =>
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
        <Fragment key={part}>{withEmoji(piece, emoji)}</Fragment>
      ),
    );
  return (
    <div className="message-text">
      {text.split('\n').map((line, index) => {
        const unc = findUncPath(line);
        if (unc) {
          // Путь — плашкой; текст после него (« — см. …», ссылка) остаётся текстом.
          const suffix = line.slice(unc.end);
          return (
            <div key={index}>
              {links(line.slice(0, unc.start))}
              <div className="path-card" aria-label={R.path}>
                <FolderOpen size={18} />
                <code>{unc.path}</code>
                <button type="button" onClick={() => void pathAction(unc.path)}>
                  {R.reveal}
                </button>
              </div>
              {suffix.trim() && <span className="path-suffix">{links(suffix)}</span>}
            </div>
          );
        }
        return (
          <span key={index}>
            {links(line)}
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

export function Attachment({
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
      setFeedback(undefined);
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
            setFeedback({
              identity,
              text: result.ok ? 'Не удалось открыть проверенное изображение.' : result.error,
              error: true,
            });
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
            onError={() => {
              setPreviewError(identity);
              setFeedback({
                identity,
                text: 'Изображение не удалось декодировать. Файл повреждён или его формат не поддерживается.',
                error: true,
              });
            }}
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
        <File size={20} aria-hidden="true" />
        <span>
          {file.fileName}
          <small>
            {file.size < 1024
              ? ReactionText.bytes(file.size)
              : new Intl.NumberFormat('ru-RU', {
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
  authorPhoto = null,
  message,
  epoch,
  ownId,
  read,
  onError,
  reactionsEnabled = true,
  onReactions,
  canWrite = false,
  canPin = false,
  pinned = false,
  onReply,
  onChange,
  onPin,
  onJump,
  firstInGroup = true,
  lastInGroup = true,
}: {
  /** Фото автора — из участников чата (у сообщения своего фото нет). */
  authorPhoto?: number | null;
  message: ChatMessage;
  epoch: number;
  ownId: number;
  read: boolean;
  onError: (message: string) => void;
  reactionsEnabled?: boolean;
  onReactions?: (messageId: number, reactions: ChatReaction[]) => void;
  canWrite?: boolean;
  canPin?: boolean;
  pinned?: boolean;
  onReply?: () => void;
  onChange?: (message: ChatMessage) => void;
  onPin?: () => void;
  onJump?: (messageId: number) => void;
  firstInGroup?: boolean;
  lastInGroup?: boolean;
}) {
  const own = message.author?.id === ownId;
  const name = message.author?.shortName ?? R.unknownAuthor;
  const hasRich = !message.deleted && (message.cards.length > 0 || message.poll !== null);
  // стикер — отдельным сообщением без «облачка» (постановка Teams 0.9.0, п. 4.4)
  const sticker = !message.deleted && !hasRich ? message.sticker : null;
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
      className={`message-row${own ? ' outgoing' : ''}${lastInGroup ? ' group-last' : ' group-middle'}`}
      data-message-id={message.id}
      aria-label={`${name}, ${timeLabel(message.at)}`}
    >
      {!own &&
        (lastInGroup ? (
          <Avatar name={name} id={message.author?.id ?? 0} photo={authorPhoto} small />
        ) : (
          <span className="avatar-gap" aria-hidden="true" />
        ))}
      <div
        className={`message-bubble${!message.deleted ? ' message-with-reactions' : ''}${sticker ? ' sticker-message' : ''}`}
      >
        {!own && firstInGroup && (
          <span className={`message-author ${colorClass(message.author?.id ?? 0)}`}>{name}</span>
        )}
        {!message.deleted && message.replyTo && (
          <button
            type="button"
            className="message-quote-button"
            aria-label="Перейти к исходному сообщению"
            onClick={() => message.replyTo && onJump?.(message.replyTo.id)}
          >
            <blockquote className="message-quote">
              <b>{message.replyTo.authorShortName ?? R.unknownAuthor}</b>
              {message.replyTo.deleted ? R.deleted : message.replyTo.preview}
            </blockquote>
          </button>
        )}
        {!(sticker && !message.text) && (
          <MessageText
            text={message.deleted ? R.deleted : message.text}
            epoch={epoch}
            onError={onError}
          />
        )}
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
        {sticker &&
          (sticker.fileId === null ? (
            <span className="sticker-deleted">{R.stickerDeleted}</span>
          ) : (
            <img
              className="message-sticker"
              src={`schema-attachment://sticker/${sticker.fileId}`}
              alt={R.sticker}
              draggable={false}
            />
          ))}
        {hasRich && (
          <div className="fallback-content">
            {R.richMessage}
            <br />
            <button type="button" onClick={() => void openWeb()}>
              <ExternalLink size={14} />
              {R.openMessageWeb}
            </button>
          </div>
        )}
        {!message.deleted && (
          <MessageReactions
            epoch={epoch}
            chatId={message.chatId}
            messageId={message.id}
            ownId={ownId}
            reactions={message.reactions}
            enabled={reactionsEnabled && canWrite && message.author !== null}
            onError={onError}
            onChange={onReactions}
          />
        )}
        {onReply && onChange && onPin && (
          <MessageActions
            message={message}
            epoch={epoch}
            ownId={ownId}
            canWrite={canWrite && reactionsEnabled}
            canPin={canPin}
            pinned={pinned}
            onReply={onReply}
            onChange={onChange}
            onPin={onPin}
          />
        )}
        <footer className="message-footer">
          {message.editedAt && <span>{R.edited}</span>}
          <time dateTime={message.at}>{timeLabel(message.at)}</time>
          {own &&
            (read ? (
              <CheckCheck size={15} aria-label={R.read} />
            ) : (
              <Check size={15} aria-label={R.sent} />
            ))}
        </footer>
      </div>
    </article>
  );
}
