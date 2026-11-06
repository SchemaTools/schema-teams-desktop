// «Плитка в «Пуске»»: Windows не даёт программе закрепить себя, поэтому показываем ярлык
// в Проводнике (главный процесс, путь фиксированный) и объясняем, как закрепить вручную.
import { useEffect, useState } from 'react';
import { request } from './bridge';
import { SchemaLogo } from './content';
import { StartMenuText as T } from './startMenuStrings';
import './startMenu.css';

/** Есть ли ярлык установщика; null — ещё не известно. */
export function useStartShortcut(): boolean | null {
  const [shortcut, setShortcut] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void request({ kind: 'startMenu.status' }).then((result) => {
      if (alive) setShortcut(result.ok ? result.data.shortcut : false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return shortcut;
}

/** Кнопка «Показать ярлык» с сообщением об ошибке; `onShown` — Проводник открыт. */
export function ShowShortcutButton({ onShown }: { onShown?: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void request({ kind: 'startMenu.reveal' }).then((result) => {
            setFailed(!result.ok);
            if (result.ok) onShown?.();
          })
        }
      >
        {T.show}
      </button>
      {failed && (
        <p role="alert" className="preferences-error">
          {T.showFailed}
        </p>
      )}
    </>
  );
}

/** Схема без скриншотов Windows: ярлык со знаком и меню с выделенным пунктом-булавкой. */
export function StartMenuPicture() {
  return (
    <figure className="start-menu-picture" aria-label={T.pictureLabel} role="img">
      <div className="start-menu-shortcut">
        <span className="start-menu-tile">
          <SchemaLogo />
        </span>
        <span className="start-menu-name" />
      </div>
      <svg className="start-menu-arrow" viewBox="0 0 40 16" aria-hidden="true">
        <path d="M2 8h32M28 3l6 5-6 5" />
      </svg>
      <div className="start-menu-context" aria-hidden="true">
        <span />
        <span className="current">
          <svg viewBox="0 0 24 24">
            <path d="M12 17v5M9 10.8V5h6v5.8l2.4 2.9a.8.8 0 0 1-.6 1.3H7.2a.8.8 0 0 1-.6-1.3z" />
          </svg>
        </span>
        <span />
      </div>
    </figure>
  );
}

/** Инструкция: шаги и картинка; без ярлыка — только текст о закреплении из списка «Пуска». */
export function StartMenuGuide({
  shortcut,
  onShown,
}: {
  shortcut: boolean | null;
  onShown?: () => void;
}) {
  return (
    <div className="start-menu-guide">
      <StartMenuPicture />
      <div>
        <p>{T.intro}</p>
        {shortcut ? (
          <ol>
            <li>{T.stepShow}</li>
            <li>
              {T.stepPin} {T.windows11}
            </li>
          </ol>
        ) : (
          <p>
            {T.fromList} {T.windows11}
          </p>
        )}
        {shortcut && <p className="start-menu-alt">{T.alternative}</p>}
        {shortcut === false && <p className="preferences-hint">{T.noShortcut}</p>}
        {shortcut && <ShowShortcutButton onShown={onShown} />}
      </div>
    </div>
  );
}
