import { useEffect, useState } from 'react';
import { Layers, RefreshCw, FlaskConical, CircleAlert, Bell } from 'lucide-react';
import type { ClientSnapshot } from '../shared/desktop';
import type { RevitInventory } from '../shared/setup';
import { PLUGIN_INSTALL_BLOCKED, type PluginEntry, type PluginWorkItem } from '../shared/plugins';
import { request } from './bridge';
import './plugins.css';
export function PluginsPage({ snapshot }: { snapshot: ClientSnapshot }) {
  const state = snapshot.plugins,
    online = snapshot.connection === 'online' && !!snapshot.user;
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [years, setYears] = useState<Record<string, (2025 | 2026)[]>>({}),
    [choice, setChoice] = useState({
      beta: !!state?.beta,
      autoUpdate: state?.autoUpdate !== false,
      notifyInstalled: state?.notifyInstalled !== false,
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
    if (!pending)
      setChoice({
        beta: !!state?.beta,
        autoUpdate: state?.autoUpdate !== false,
        notifyInstalled: state?.notifyInstalled !== false,
      });
  }, [state?.beta, state?.autoUpdate, state?.notifyInstalled, pending, snapshot.revision]);
  async function preferences(patch: {
    beta?: boolean;
    autoUpdate?: boolean;
    notifyInstalled?: boolean;
  }) {
    setChoice((before) => ({ ...before, ...patch }));
    setPending(true);
    setError('');
    const r = await request({ kind: 'plugins.preferences', epoch: snapshot.epoch, ...patch });
    if (!r.ok) setError(r.error);
    setPending(false);
  }
  const catalog = state?.catalog;
  const managed = state?.managed,
    workflow = state?.workflow,
    active = workflow?.active === true,
    available = managed?.installationAvailable === true && managed.status === 'ready';
  function group(p: PluginEntry): string {
    if (workflow?.items.some((i) => i.code === p.code && i.phase === 'waiting'))
      return 'Ожидают закрытия Revit';
    if (managed?.packages.some((i) => i.code === p.code)) return 'Установленные';
    return 'Доступные';
  }
  const phaseText = (item: PluginWorkItem) =>
    ({
      checking: 'Проверяем сборку и зависимости…',
      downloading: 'Загружаем и проверяем файлы…',
      installing: 'Устанавливаем проверенный набор…',
      waiting: 'Ожидаем закрытия всех процессов Revit. Затем проверим сборку заново.',
      complete:
        item.reason === 'already_installed'
          ? 'Эта сборка уже установлена.'
          : 'Установка подтверждена.',
      error:
        item.reason === 'automatic_rollback_hold'
          ? 'Автообновление этой сборки остановлено после отката. Для повторной установки выберите её вручную.'
          : item.reason === 'revit_inventory_changed'
            ? 'Список установленного Revit изменился. Повторите проверку.'
            : 'Операция не подтверждена. Повторите проверку; сведения сохранены в журнале.',
    })[item.phase];
  async function job(
    intent:
      | { kind: 'plugins.install'; code: string; years: (2025 | 2026)[] }
      | { kind: 'plugins.rollback'; receiptId: string }
      | { kind: 'plugins.recover' },
  ) {
    setPending(true);
    setError('');
    try {
      const result = await request({ ...intent, epoch: snapshot.epoch });
      if (!result.ok) setError(result.error);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="plugins-page" aria-label="Плагины Revit">
      <div className="plugins-column">
        <header className="plugins-hero">
          <span className="plugins-symbol">
            <Layers size={32} />
          </span>
          <div>
            <h1>Плагины Revit</h1>
            <p>
              {managed?.status === 'ready'
                ? 'Управляемые версии проверены по локальным файлам и подписи.'
                : 'Сведения об установленных версиях пока неизвестны.'}
            </p>
          </div>
          <button
            type="button"
            disabled={!online || state?.status === 'loading' || active}
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
        {active && <p role="status">Проверяем обновления плагинов…</p>}
        {!available && !active && (
          <div className="plugins-trust" role="status">
            <CircleAlert size={22} />
            <div>
              <b>
                {managed?.status === 'recovery'
                  ? 'Обнаружена незавершённая операция.'
                  : managed?.status === 'blocked'
                    ? 'Управляемые файлы не прошли проверку.'
                    : PLUGIN_INSTALL_BLOCKED}
              </b>
              <p>
                {managed?.status === 'recovery'
                  ? 'Файлы сохранены. Восстановление проверит предыдущий набор перед его активацией.'
                  : managed?.status === 'blocked'
                    ? 'Установка и откат заблокированы. Проверьте подключение и повторите проверку файлов.'
                    : 'Каталог не подтверждает подпись DLL. Автоматическая установка и загрузка пакетов отключены до настройки доверия и проверки установки.'}
              </p>
            </div>
          </div>
        )}
        {managed?.status === 'recovery' && managed.installationAvailable && (
          <button
            disabled={pending || active || !online}
            onClick={() => void job({ kind: 'plugins.recover' })}
          >
            Восстановить незавершённую операцию
          </button>
        )}
        {managed?.status === 'ready' && managed.receiptId && (
          <button
            disabled={pending || active || !online}
            onClick={() =>
              void job({ kind: 'plugins.rollback', receiptId: managed.receiptId as string })
            }
          >
            Проверить и откатить предыдущий набор
          </button>
        )}
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
            {['Ожидают закрытия Revit', 'Установленные', 'Доступные'].map(
              (category) =>
                catalog.plugins.some((p) => group(p) === category) && (
                  <section key={category} aria-label={category}>
                    <h3>{category}</h3>
                    {catalog.plugins
                      .filter((p) => group(p) === category)
                      .map((p) => {
                        const beta = state?.beta && catalog.tester && p.beta;
                        const build = beta || p.stable;
                        const work = workflow?.items.find((i) => i.code === p.code);
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
                                    {managed?.status === 'ready' &&
                                    managed.packages.some((x) => x.code === p.code)
                                      ? managed.packages
                                          .filter((x) => x.code === p.code)
                                          .map(
                                            (x) =>
                                              `Установлено ${x.version} · Revit ${x.years.join(', ')}`,
                                          )
                                          .join('; ')
                                      : 'Установка не подтверждена'}
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
                                  {work && (
                                    <div
                                      className="plugin-work"
                                      data-phase={work.phase}
                                      role="status"
                                    >
                                      <p>{phaseText(work)}</p>
                                      {['checking', 'downloading', 'installing'].includes(
                                        work.phase,
                                      ) && (
                                        <progress aria-label={`${p.name}: операция выполняется`} />
                                      )}
                                    </div>
                                  )}
                                  {build.revit
                                    .filter(
                                      (year): year is 2025 | 2026 => year === 2025 || year === 2026,
                                    )
                                    .map((year) => (
                                      <label key={year}>
                                        <input
                                          type="checkbox"
                                          aria-label={`${p.name}: Revit ${year}`}
                                          checked={years[p.code]?.includes(year) ?? false}
                                          disabled={
                                            !available ||
                                            pending ||
                                            active ||
                                            !inventory?.years.some(
                                              (y) => y.year === year && y.executable === 'found',
                                            )
                                          }
                                          onChange={(e) =>
                                            setYears((before) => ({
                                              ...before,
                                              [p.code]: e.target.checked
                                                ? [...(before[p.code] ?? []), year]
                                                : (before[p.code] ?? []).filter((y) => y !== year),
                                            }))
                                          }
                                        />
                                        Revit {year}
                                      </label>
                                    ))}
                                </>
                              ) : (
                                <p>Нет доступной сборки.</p>
                              )}
                            </div>
                            <button
                              type="button"
                              disabled={
                                !online ||
                                !available ||
                                pending ||
                                active ||
                                !build ||
                                !years[p.code]?.length ||
                                work?.phase === 'waiting'
                              }
                              title={!available ? PLUGIN_INSTALL_BLOCKED : undefined}
                              onClick={() =>
                                void job({
                                  kind: 'plugins.install',
                                  code: p.code,
                                  years: years[p.code] ?? [],
                                })
                              }
                            >
                              {work?.phase === 'waiting'
                                ? 'Установим после закрытия Revit'
                                : 'Установить'}
                            </button>
                          </article>
                        );
                      })}
                  </section>
                ),
            )}
          </section>
        )}
        <section className="plugins-settings" aria-label="Настройки плагинов">
          <label>
            <RefreshCw size={22} />
            <span>
              <b>Обновлять автоматически</b>
              <small>
                {managed?.installationAvailable
                  ? 'Проверенные сборки установятся после закрытия всех процессов Revit.'
                  : 'Предпочтение сохранится; установка пока недоступна.'}
              </small>
            </span>
            <input
              type="checkbox"
              checked={choice.autoUpdate}
              disabled={!online || !catalog || pending}
              onChange={(e) => void preferences({ autoUpdate: e.target.checked })}
            />
          </label>
          <label>
            <Bell size={22} />
            <span>
              <b>Сообщать об установке</b>
              <small>Уведомлять после подтверждённого обновления плагинов.</small>
            </span>
            <input
              type="checkbox"
              checked={choice.notifyInstalled}
              disabled={!online || !catalog || pending}
              onChange={(e) => void preferences({ notifyInstalled: e.target.checked })}
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
