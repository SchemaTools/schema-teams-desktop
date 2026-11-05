// Сведения о чате (замечание 5 к PR #6) — как панель сведений сайта (Teams 0.11.0, раздел 3):
// обложка, название и вид чата; участники; картинки и файлы чата с «Показать ещё».
// Действия управления (переименовать, состав) остаются на сайте.
import { ChevronRight, Info, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatAttachmentItem, ChatDetail, ChatSummary } from '../shared/client';
import { request } from './bridge';
import { Attachment, Avatar } from './content';
import { R } from './strings';
import './chatInfo.css';

type Media = {
  items: ChatAttachmentItem[];
  hasMore: boolean;
  loading: boolean;
  error: string;
};
const emptyMedia = (): Media => ({ items: [], hasMore: false, loading: true, error: '' });

function useMedia(epoch: number, chatId: number, type: 'image' | 'file', online: boolean) {
  const [media, setMedia] = useState<Media>(emptyMedia);
  // смена чата или входа — раздел создаётся заново (key у родителя), с первой страницы
  const [page, setPage] = useState<{ before?: number; n: number }>({ n: 0 });
  useEffect(() => {
    if (!online) {
      setMedia((old) => ({ ...old, loading: false, error: old.items.length ? '' : R.infoOffline }));
      return;
    }
    let alive = true;
    setMedia((old) => ({ ...old, loading: true, error: '' }));
    void request({
      kind: 'chat.attachments',
      epoch,
      chatId,
      type,
      ...(page.before !== undefined && { before: page.before }),
    }).then((result) => {
      if (!alive) return;
      setMedia((old) =>
        result.ok
          ? {
              items: [
                ...old.items,
                ...result.data.items.filter((item) => !old.items.some((o) => o.id === item.id)),
              ],
              hasMore: result.data.hasMore,
              loading: false,
              error: '',
            }
          : { ...old, loading: false, error: result.error },
      );
    });
    return () => {
      alive = false;
    };
  }, [epoch, chatId, type, online, page]);
  const more = () => {
    const last = media.items.at(-1);
    if (last && !media.loading) setPage((p) => ({ before: last.id, n: p.n + 1 }));
  };
  const retry = () => setPage((p) => ({ ...p, n: p.n + 1 }));
  return { media, more, retry };
}

function MediaSection({
  title,
  type,
  epoch,
  chatId,
  online,
}: {
  title: string;
  type: 'image' | 'file';
  epoch: number;
  chatId: number;
  online: boolean;
}) {
  const { media, more, retry } = useMedia(epoch, chatId, type, online);
  return (
    <section className={`chat-info-section chat-info-${type}s`} aria-label={title}>
      <h4>{title}</h4>
      {media.items.length === 0 && !media.loading && !media.error && (
        <p className="chat-info-note">{type === 'image' ? R.noImages : R.noFiles}</p>
      )}
      <div className={type === 'image' ? 'chat-info-image-grid' : 'chat-info-file-list'}>
        {media.items.map((item) => (
          <div key={item.id} className="chat-info-media-item" title={item.file.fileName}>
            <Attachment file={item.file} epoch={epoch} chatId={chatId} messageId={item.messageId} />
          </div>
        ))}
      </div>
      {media.loading && (
        <p className="chat-info-note" role="status">
          {R.infoLoading}
        </p>
      )}
      {media.error && (
        <p className="chat-info-note" role="alert">
          {media.error}{' '}
          <button type="button" className="chat-info-retry" disabled={!online} onClick={retry}>
            {R.retry}
          </button>
        </p>
      )}
      {media.hasMore && !media.loading && (
        <button type="button" className="secondary-button chat-info-more" onClick={more}>
          {R.showMore}
        </button>
      )}
    </section>
  );
}

const kindLabel = (chat: ChatSummary) =>
  chat.kind === 'direct'
    ? R.kindDirect
    : chat.kind === 'object'
      ? R.kindObject
      : chat.kind === 'bureau'
        ? R.kindBureau
        : R.kindGroup;

export function ChatInfoPanel({
  epoch,
  chat,
  title,
  detail,
  ownId,
  online,
  onClose,
  onObject,
}: {
  epoch: number;
  chat: ChatSummary;
  title: string;
  detail: ChatDetail | null;
  ownId: number;
  online: boolean;
  onClose: () => void;
  /** Чат объекта — перейти к «Об объекте». */
  onObject?: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => close.current?.focus(), []);
  // сначала остальные по алфавиту, себя — в конце
  const members = [...(detail?.members ?? [])].sort((a, b) =>
    a.user.id === ownId
      ? 1
      : b.user.id === ownId
        ? -1
        : a.user.shortName.localeCompare(b.user.shortName, 'ru'),
  );
  return (
    <aside
      className="object-info-panel chat-info-panel"
      id="chat-info-panel"
      role="region"
      aria-label={R.chatInfo}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <Info size={20} />
        <h2>{R.chatInfo}</h2>
        <button
          type="button"
          ref={close}
          className="icon-button"
          aria-label={R.closeChatInfo}
          onClick={onClose}
        >
          <X size={19} />
        </button>
      </header>
      <div className="object-info-body chat-info-body">
        <div className="chat-info-cover">
          <Avatar
            name={chat.kind === 'object' ? chat.objectCode || title : title}
            id={chat.peer?.id ?? chat.id}
            photo={chat.photoFileId}
            object={chat.kind === 'object'}
          />
          <h3>{title}</h3>
          <p>
            {kindLabel(chat)} · {R.members(detail?.members.length ?? chat.memberCount)}
          </p>
        </div>
        {onObject && (
          <button type="button" className="chat-info-row" onClick={onObject}>
            <Info size={18} />
            <span>{R.aboutObject}</span>
            <ChevronRight size={18} />
          </button>
        )}
        <section className="chat-info-section" aria-label={R.participants}>
          <h4>
            {R.participants} · {members.length || chat.memberCount}
          </h4>
          {!detail && <p className="chat-info-note">{R.infoLoading}</p>}
          <ul className="chat-info-members">
            {members.map((member) => (
              <li key={member.user.id}>
                <Avatar
                  name={member.user.shortName}
                  id={member.user.id}
                  photo={member.photoFileId}
                  small
                />
                <span className="chat-info-member-name">{member.user.shortName}</span>
                {member.user.id === ownId && <small>{R.you}</small>}
              </li>
            ))}
          </ul>
        </section>
        <MediaSection
          key={`image:${epoch}:${chat.id}`}
          title={R.images}
          type="image"
          epoch={epoch}
          chatId={chat.id}
          online={online}
        />
        <MediaSection
          key={`file:${epoch}:${chat.id}`}
          title={R.files}
          type="file"
          epoch={epoch}
          chatId={chat.id}
          online={online}
        />
      </div>
    </aside>
  );
}
