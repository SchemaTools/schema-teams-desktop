import { Smile } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatSticker } from '../shared/client';
import { request } from './bridge';
import { reactionAssets } from './reactionAssets';
import { R } from './strings';
const choices = [
  ['like', '👍', 'Нравится'],
  ['heart', '❤️', 'Сердце'],
  ['done', '✅', 'Готово'],
  ['look', '👀', 'Смотрю'],
  ['laugh', '😂', 'Смешно'],
  ['question', '❓', 'Вопрос'],
] as const;

type StickerState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; items: ChatSticker[] }
  | { status: 'error'; error: string };

/**
 * Панель эмодзи и стикеров бюро (постановка Teams 0.9.0, п. 4.4): две вкладки.
 * Стикер уходит сразу отдельным сообщением; эмодзи вставляется в поле ввода.
 */
export function EmojiPicker({
  disabled,
  onPick,
  onSticker,
  epoch,
  stickersRevision = 0,
}: {
  disabled: boolean;
  onPick: (emoji: string) => void;
  /** Нет — вкладки «Стикеры бюро» нет (например, нельзя отправить сообщение). */
  onSticker?: (sticker: ChatSticker) => void;
  epoch: number;
  /** Набор бюро изменился на сервере — перечитать при следующем открытии. */
  stickersRevision?: number;
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<'emoji' | 'stickers'>('emoji'),
    [stickers, setStickers] = useState<StickerState>({ status: 'idle' }),
    loadedFor = useRef<string | null>(null),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    const key = `${epoch}:${stickersRevision}`;
    if (!open || tab !== 'stickers' || loadedFor.current === key) return;
    loadedFor.current = key;
    let alive = true;
    setStickers((old) => (old.status === 'ready' ? old : { status: 'loading' }));
    void request({ kind: 'chat.stickers', epoch }).then((result) => {
      if (!alive) return;
      if (result.ok)
        setStickers({ status: 'ready', items: result.data.filter((s) => s.kind === 'sticker') });
      else {
        loadedFor.current = null;
        setStickers({ status: 'error', error: result.error });
      }
    });
    return () => {
      alive = false;
    };
  }, [open, tab, epoch, stickersRevision]);
  return (
    <div
      className="emoji-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="composer-attach-button"
        aria-label={onSticker ? R.emojiAndStickers : 'Эмодзи'}
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Smile size={21} />
      </button>
      {open && !disabled && (
        <div className="emoji-picker-panel" role="group" aria-label={R.emojiAndStickers}>
          {onSticker && (
            <div className="emoji-picker-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'emoji'}
                onClick={() => setTab('emoji')}
              >
                {R.emojiTab}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'stickers'}
                onClick={() => setTab('stickers')}
              >
                {R.stickersTab}
              </button>
            </div>
          )}
          {tab === 'emoji' || !onSticker ? (
            <div className="emoji-picker-grid" role="tabpanel" aria-label="Выбрать эмодзи">
              {choices.map(([kind, emoji, label]) => (
                <button
                  type="button"
                  key={kind}
                  aria-label={`Вставить эмодзи «${label}»`}
                  onClick={() => {
                    onPick(emoji);
                    setOpen(false);
                  }}
                >
                  <img src={reactionAssets[kind]} alt="" />
                </button>
              ))}
            </div>
          ) : (
            <div className="sticker-picker-grid" role="tabpanel" aria-label={R.stickersTab}>
              {stickers.status === 'ready' && stickers.items.length === 0 && (
                <p className="sticker-picker-note">{R.noStickers}</p>
              )}
              {stickers.status === 'loading' && (
                <p className="sticker-picker-note">{R.loadingStickers}</p>
              )}
              {stickers.status === 'error' && (
                <p className="sticker-picker-note" role="alert">
                  {stickers.error}
                </p>
              )}
              {stickers.status === 'ready' &&
                stickers.items.map((sticker) => (
                  <button
                    type="button"
                    key={sticker.id}
                    className="sticker-choice"
                    aria-label={R.sendSticker(sticker.author?.shortName ?? null)}
                    title={
                      sticker.author ? R.stickerAuthor(sticker.author.shortName) : R.stickersTab
                    }
                    onClick={() => {
                      onSticker(sticker);
                      setOpen(false);
                    }}
                  >
                    <img src={`schema-attachment://sticker/${sticker.fileId}`} alt="" />
                  </button>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
