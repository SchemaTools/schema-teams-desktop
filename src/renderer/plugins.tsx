import { useEffect, useState } from 'react';
import { Layers, RefreshCw, FlaskConical, CircleAlert } from 'lucide-react';
import type { ClientSnapshot } from '../shared/desktop';
import type { RevitInventory } from '../shared/setup';
import { PLUGIN_INSTALL_BLOCKED } from '../shared/plugins';
import { request } from './bridge';
import './plugins.css';
export function PluginsPage({ snapshot }: { snapshot: ClientSnapshot }) {
  const state = snapshot.plugins,
    online = snapshot.connection === 'online' && !!snapshot.user;
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [choice, setChoice] = useState({
      beta: !!state?.beta,
      autoUpdate: state?.autoUpdate !== false,
    }),
    [inventory, setInventory] = useState<RevitInventory | null>(null);
  useEffect(() => {
    let active = true;
    setInventory(null);
    if (online)
      void request({ kind: 'setup.inventory' }).then((r) => {
        if (active && r.ok) setInventory(r.data);
      });
    return () => {
      active = false;
    };
  }, [snapshot.epoch, online]);
  useEffect(() => {
    if (!pending) setChoice({ beta: !!state?.beta, autoUpdate: state?.autoUpdate !== false });
  }, [state?.beta, state?.autoUpdate, pending, snapshot.revision]);
  async function preferences(patch: { beta?: boolean; autoUpdate?: boolean }) {
    setChoice((before) => ({ ...before, ...patch }));
    setPending(true);
    setError('');
    const r = await request({ kind: 'plugins.preferences', epoch: snapshot.epoch, ...patch });
    if (!r.ok) setError(r.error);
    setPending(false);
  }
  const catalog = state?.catalog;
  return (
    <section className="plugins-page" aria-label="Плагины Revit">
      <div className="plugins-column">
        <header className="plugins-hero">
          <span className="plugins-symbol">
            <Layers size={32} />
          </span>
          <div>
            <h1>Плагины Revit</h1>
            <p>Сведения об установленных версиях пока неизвестны.</p>
          </div>
          <button
            type="button"
            disabled={!online || state?.status === 'loading'}
            onClick={() => {
              setError('');
              void request({ kind: 'plugins.refresh', epoch: snapshot.epoch }).then((r) => {
                if (!r.ok) setError(r.error);
              });
            }}
          >
            <RefreshCw size={18} />
            Проверить
          </button>
        </header>
        <div className="plugins-trust" role="status">
          <CircleAlert size={22} />
          <div>
            <b>{PLUGIN_INSTALL_BLOCKED}</b>
            <p>
              Каталог не подтверждает подпись DLL. Автоматическая установка и загрузка пакетов
              отключены до настройки доверия и проверки установки.
            </p>
          </div>
        </div>
        {error && <p role="alert">{error}</p>}
        {state?.error && <p role="alert">{state.error}</p>}
        {!online ? (
          <p>Войдите и подключитесь к серверу, чтобы прочитать каталог.</p>
        ) : state?.status === 'unavailable' ? (
          <p>Этот сервер не предоставляет каталог плагинов Desktop.</p>
        ) : state?.status === 'loading' && !catalog ? (
          <p role="status">Читаем каталог…</p>
        ) : null}
        {catalog && (
          <section aria-label="Каталог плагинов">
            <h2>Доступные сборки</h2>
            {catalog.plugins.length === 0 && (
              <p>В каталоге пока нет плагинов. Это не означает, что всё установлено.</p>
            )}
            {catalog.plugins.map((p) => {
              const beta = state?.beta && catalog.tester && p.beta;
              const build = beta || p.stable;
              return (
                <article className="plugin-card" key={p.code} data-plugin={p.code}>
                  <span className="plugin-short" aria-hidden="true">
                    {p.short}
                  </span>
                  <div className="plugin-description">
                    <h3>{p.name}</h3>
                    {build ? (
                      <>
                        <p>
                          <span className="plugin-version">{build.version}</span> ·{' '}
                          {beta ? 'Пробная' : 'Рабочая'} · Revit {build.revit.join(', ')}
                        </p>
                        <p>
                          Установка не подтверждена
                          {!build.verified ? ' · Сборка не отмечена проверенной' : ''}
                        </p>
                        <details>
                          <summary>Что нового</summary>
                          <p className="plugin-notes">
                            {build.notes || 'Описание изменений отсутствует.'}
                          </p>
                          <p>
                            Зависимости:{' '}
                            {build.requires.length
                              ? build.requires
                                  .map((r) => `${r.plugin} ≥ ${r.minVersion}`)
                                  .join(', ')
                              : 'не указаны'}
                          </p>
                        </details>
                      </>
                    ) : (
                      <p>Нет доступной сборки.</p>
                    )}
                  </div>
                  <button type="button" disabled title={PLUGIN_INSTALL_BLOCKED}>
                    Установить
                  </button>
                </article>
              );
            })}
          </section>
        )}
        <section className="plugins-settings" aria-label="Настройки плагинов">
          <label>
            <RefreshCw size={22} />
            <span>
              <b>Обновлять автоматически</b>
              <small>Предпочтение сохранится; установка пока недоступна.</small>
            </span>
            <input
              type="checkbox"
              checked={choice.autoUpdate}
              disabled={!online || !catalog || pending}
              onChange={(e) => void preferences({ autoUpdate: e.target.checked })}
            />
          </label>
          {catalog?.tester && (
            <label>
              <FlaskConical size={22} />
              <span>
                <b>Пробные сборки</b>
                <small>Вы назначены испытателем.</small>
              </span>
              <input
                type="checkbox"
                checked={!!catalog?.tester && choice.beta}
                disabled={!online || !catalog?.tester || pending}
                onChange={(e) => void preferences({ beta: e.target.checked })}
              />
            </label>
          )}
        </section>
        {inventory && (
          <section aria-label="Локальные файлы Revit">
            <h2>Локальные файлы Revit</h2>
            <p>
              Имена .addin не подтверждают плагин, версию или подпись. Без записи управляемой
              установки версия неизвестна.
            </p>
            {inventory.years.map((y) => (
              <div key={y.year}>
                <h3>Revit {y.year}</h3>
                <p>
                  {y.executable === 'found'
                    ? 'Revit обнаружен'
                    : y.executable === 'notFound'
                      ? 'Revit не обнаружен'
                      : 'Наличие Revit проверить не удалось'}
                </p>
                {y.addins.map((a) => (
                  <p key={a.scope}>
                    {a.scope === 'user' ? 'Пользователь' : 'Компьютер'}:{' '}
                    {a.names.length
                      ? a.names.map((n) => `${n} — версия неизвестна`).join('; ')
                      : a.status === 'ok' || a.status === 'missing'
                        ? 'файлы .addin не обнаружены'
                        : 'не удалось прочитать'}
                    {a.truncated ? ' (неполный список)' : ''}
                  </p>
                ))}
              </div>
            ))}
          </section>
        )}
      </div>
    </section>
  );
}
