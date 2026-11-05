import { Smile } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
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

export type BureauSet =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; items: ChatSticker[] }
  | { status: 'error'; error: string };

/**
 * Набор бюро — стикеры и свои эмодзи (`GET /api/chat-stickers`). Нужен и панели, и ленте
 * (`:код:` в тексте), поэтому грузится один раз на вход и заново по `chat:stickers`.
 */
export function useBureauSet(
  epoch: number,
  revision: number,
  enabled: boolean,
): { set: BureauSet; retry: () => void } {
  const [set, setSet] = useState<BureauSet>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setSet((old) => (old.status === 'ready' ? old : { status: 'loading' }));
    void request({ kind: 'chat.stickers', epoch }).then((result) => {
      if (!alive) return;
      setSet(
        result.ok
          ? { status: 'ready', items: result.data }
          : { status: 'error', error: result.error },
      );
    });
    return () => {
      alive = false;
    };
  }, [epoch, revision, enabled, attempt]);
  // смена входа — набор прежнего пользователя не показывать
  useEffect(() => setSet({ status: 'idle' }), [epoch]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { set, retry };
}

/** Код эмодзи бюро → ид файла картинки: для ленты сообщений. */
export function bureauEmojiMap(set: BureauSet): ReadonlyMap<string, number> {
  return new Map(
    set.status === 'ready'
      ? set.items.filter((s) => s.kind === 'emoji' && s.name).map((s) => [s.name, s.fileId])
      : [],
  );
}

/**
 * Панель эмодзи и стикеров бюро (постановка Teams 0.9.0, п. 4.4): две вкладки.
 * Эмодзи вставляется в поле ввода (свой эмодзи бюро — кодом `:код:`), стикер уходит сразу
 * отдельным сообщением.
 */
export function EmojiPicker({
  disabled,
  onPick,
  onSticker,
  bureau,
}: {
  disabled: boolean;
  onPick: (emoji: string) => void;
  /** Нет — вкладки «Стикеры бюро» нет. */
  onSticker?: (sticker: ChatSticker) => void;
  /** Набор бюро; нет — только стандартные эмодзи. */
  bureau?: { set: BureauSet; retry: () => void };
}) {
  const [open, setOpen] = useState(false),
    [tab, setTab] = useState<'emoji' | 'stickers'>('emoji'),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  const set = bureau?.set ?? { status: 'idle' },
    items = set.status === 'ready' ? set.items : [],
    emoji = items.filter((s) => s.kind === 'emoji' && s.name),
    stickers = items.filter((s) => s.kind === 'sticker');
  const note =
    set.status === 'loading' ? (
      <p className="sticker-picker-note">{R.loadingStickers}</p>
    ) : set.status === 'error' ? (
      <p className="sticker-picker-note" role="alert">
        {set.error}{' '}
        <button type="button" className="sticker-picker-retry" onClick={() => bureau?.retry()}>
          {R.retry}
        </button>
      </p>
    ) : null;
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
            <div role="tabpanel" aria-label="Выбрать эмодзи">
              <div className="emoji-picker-grid">
                {choices.map(([kind, symbol, label]) => (
                  <button
                    type="button"
                    key={kind}
                    aria-label={`Вставить эмодзи «${label}»`}
                    onClick={() => {
                      onPick(symbol);
                      setOpen(false);
                    }}
                  >
                    <img src={reactionAssets[kind]} alt="" />
                  </button>
                ))}
              </div>
              {bureau && (emoji.length > 0 || note) && (
                <>
                  <p className="emoji-picker-caption">{R.bureauEmoji}</p>
                  <div className="emoji-picker-grid bureau-emoji-grid">
                    {emoji.map((item) => (
                      <button
                        type="button"
                        key={item.id}
                        aria-label={`Вставить эмодзи «:${item.name}:»`}
                        title={`:${item.name}:${item.author ? ` · ${R.stickerAuthor(item.author.shortName)}` : ''}`}
                        onClick={() => {
                          onPick(`:${item.name}:`);
                          setOpen(false);
                        }}
                      >
                        <img src={`schema-attachment://sticker/${item.fileId}`} alt="" />
                      </button>
                    ))}
                    {note}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="sticker-picker-grid" role="tabpanel" aria-label={R.stickersTab}>
              {set.status === 'ready' && stickers.length === 0 && (
                <p className="sticker-picker-note">{R.noStickers}</p>
              )}
              {note}
              {stickers.map((sticker) => (
                <button
                  type="button"
                  key={sticker.id}
                  className="sticker-choice"
                  aria-label={R.sendSticker(sticker.author?.shortName ?? null)}
                  title={sticker.author ? R.stickerAuthor(sticker.author.shortName) : R.stickersTab}
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
