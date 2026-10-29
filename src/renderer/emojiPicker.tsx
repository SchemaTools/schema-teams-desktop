import { Smiley } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { reactionAssets } from './reactionAssets';
const choices = [
  ['like', '👍', 'Нравится'],
  ['heart', '❤️', 'Сердце'],
  ['done', '✅', 'Готово'],
  ['look', '👀', 'Смотрю'],
  ['laugh', '😂', 'Смешно'],
  ['question', '❓', 'Вопрос'],
] as const;
export function EmojiPicker({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (emoji: string) => void;
}) {
  const [open, setOpen] = useState(false),
    root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
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
        aria-label="Эмодзи"
        aria-expanded={open && !disabled}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Smiley size={21} />
      </button>
      {open && !disabled && (
        <div className="emoji-picker-panel" role="group" aria-label="Выбрать эмодзи">
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
      )}
    </div>
  );
}
