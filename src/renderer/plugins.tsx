import { useEffect, useState } from 'react';
import { Layers, RefreshCw, FlaskConical, CircleAlert, Bell } from 'lucide-react';
import type { ClientSnapshot } from '../shared/desktop';
import {
  comparePluginVersions,
  type InstalledPluginView,
  type PluginBuild,
  type PluginCatalog,
  type PluginEntry,
  type PluginWorkItem,
} from '../shared/plugins';
import { request } from './bridge';
import { P } from './pluginStrings';
import './plugins.css';

type Group = 'waiting' | 'errors' | 'installed' | 'available';
const GROUPS: readonly [Group, string][] = [
  ['waiting', P.groupWaiting],
  ['errors', P.groupErrors],
  ['installed', P.groupInstalled],
  ['available', P.groupAvailable],
];
/** Та же сборка, что выберет главный процесс: пробная — испытателю, если новее. */
function selected(entry: PluginEntry, catalog: PluginCatalog, beta: boolean): PluginBuild | null {
  const trial = beta && catalog.tester ? entry.beta : null;
  if (trial && (!entry.stable || comparePluginVersions(trial.version, entry.stable.version) > 0))
    return trial;
  return entry.stable ?? trial ?? null;
}

export function PluginsPage({ snapshot }: { snapshot: ClientSnapshot }) {
  const state = snapshot.plugins,
    online = snapshot.connection === 'online' && !!snapshot.user;
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [choice, setChoice] = useState({
      beta: !!state?.beta,
      autoUpdate: state?.autoUpdate !== false,
      notifyInstalled: state?.notifyInstalled !== false,
    });
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
  async function act(kind: 'plugins.install' | 'plugins.rollback', code: string) {
    setPending(true);
    setError('');
    try {
      const r = await request({ kind, code, epoch: snapshot.epoch });
      if (!r.ok) setError(r.error);
    } finally {
      setPending(false);
    }
  }
  const catalog = state?.catalog ?? null,
    managed = state?.managed,
    workflow = state?.workflow,
    available = managed?.available === true,
    installed = (code: string) => managed?.plugins.find((p) => p.code === code),
    work = (code: string) => workflow?.items.find((i) => i.code === code);
  function group(p: PluginEntry): Group {
    const item = work(p.code),
      local = installed(p.code);
    if (item?.phase === 'waiting') return 'waiting';
    if (item?.phase === 'error' || (local && local.status !== 'ok')) return 'errors';
    return local ? 'installed' : 'available';
  }
  const builds = catalog
    ? catalog.plugins.map((p) => ({ p, build: selected(p, catalog, !!state?.beta) }))
    : [];
  const total = builds.filter((b) => b.build).length,
    fresh = builds.filter(({ p, build }) => {
      const local = installed(p.code);
      return build && local?.status === 'ok' && local.version === build.version;
    }).length,
    waiting = workflow?.items.filter((i) => i.phase === 'waiting').length ?? 0,
    errors = catalog ? catalog.plugins.filter((p) => group(p) === 'errors').length : 0;
  const hero = workflow?.active
    ? P.heroChecking
    : managed?.recovering
      ? P.heroRecovering
      : waiting
        ? P.heroWaiting(waiting)
        : errors
          ? P.heroErrors
          : state?.autoUpdate === false
            ? P.heroManual
            : P.heroFresh;
  return (
    <section className="plugins-page" aria-label={P.title}>
      <div className="plugins-column">
        <header className="plugins-hero">
          <span className="plugins-symbol">
            <Layers size={28} />
          </span>
          <div>
            <h1>{P.title}</h1>
            {catalog && <p className="plugins-count">{P.upToDate(fresh, total)}</p>}
            {catalog && <p role="status">{hero}</p>}
          </div>
          <button
            type="button"
            disabled={!online || state?.status === 'loading' || workflow?.active}
            onClick={() => {
              setError('');
              void request({ kind: 'plugins.refresh', epoch: snapshot.epoch }).then((r) => {
                if (!r.ok) setError(r.error);
              });
            }}
          >
            <RefreshCw size={18} />
            {P.check}
          </button>
        </header>
        {!available && online && state?.status !== 'unavailable' && (
          <div className="plugins-trust" role="status">
            <CircleAlert size={22} />
            <div>
              <b>{P.trustBlocked}</b>
              <p>{P.trustBlockedHint}</p>
            </div>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
        {state?.error && <p role="alert">{state.error}</p>}
        {!online ? (
          <p>{P.signIn}</p>
        ) : state?.status === 'unavailable' ? (
          <p>{P.unavailable}</p>
        ) : state?.status === 'loading' && !catalog ? (
          <p role="status">{P.loading}</p>
        ) : null}
        {catalog && catalog.plugins.length === 0 && <p>{P.empty}</p>}
        {catalog &&
          GROUPS.map(
            ([id, title]) =>
              catalog.plugins.some((p) => group(p) === id) && (
                <section key={id} className="plugins-group" aria-label={title}>
                  <h2>{title}</h2>
                  {builds
                    .filter(({ p }) => group(p) === id)
                    .map(({ p, build }) => (
                      <PluginRow
                        key={p.code}
                        entry={p}
                        build={build}
                        local={installed(p.code)}
                        item={work(p.code)}
                        trial={!!build && build === p.beta}
                        revitOpen={workflow?.revitOpen === true}
                        busy={pending || !online}
                        available={available}
                        onAct={(kind) => void act(kind, p.code)}
                      />
                    ))}
                </section>
              ),
          )}
        <section className="plugins-settings" aria-label="Настройки плагинов">
          <label>
            <RefreshCw size={22} />
            <span>
              <b>{P.autoUpdate}</b>
              <small>{P.autoUpdateHint}</small>
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
              <b>{P.notify}</b>
              <small>{P.notifyHint}</small>
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
                <b>{P.beta}</b>
                <small>{P.betaHint}</small>
              </span>
              <input
                type="checkbox"
                checked={choice.beta}
                disabled={!online || pending}
                onChange={(e) => void preferences({ beta: e.target.checked })}
              />
            </label>
          )}
        </section>
      </div>
    </section>
  );
}

function PluginRow(props: {
  entry: PluginEntry;
  build: PluginBuild | null;
  local: InstalledPluginView | undefined;
  item: PluginWorkItem | undefined;
  trial: boolean;
  revitOpen: boolean;
  busy: boolean;
  available: boolean;
  onAct: (kind: 'plugins.install' | 'plugins.rollback') => void;
}) {
  const { entry, build, local, item, trial, revitOpen, busy, available, onAct } = props;
  const running = item?.phase === 'downloading' || item?.phase === 'installing',
    broken = !!local && local.status !== 'ok';
  const version =
    local && build && local.version !== build.version
      ? `${local.version} → ${build.version}`
      : (local?.version ?? build?.version ?? '');
  const years = local?.years.length ? local.years : (build?.revit ?? []);
  const chip =
    local?.status === 'damaged'
      ? P.chipDamaged
      : local?.status === 'disabled'
        ? P.chipDisabled
        : item?.phase === 'waiting'
          ? P.chipWaiting
          : !local
            ? P.chipMissing
            : trial
              ? P.chipTrial
              : P.chipFresh;
  const status =
    item?.phase === 'error'
      ? P.reason(item.reason, item.detail)
      : item?.phase === 'waiting'
        ? item.kind === 'rollback'
          ? P.phase.rollbackWaiting
          : P.phase.waiting
        : item && (item.phase !== 'complete' || !broken)
          ? P.phase[item.phase]
          : local?.status === 'damaged'
            ? P.damaged
            : local?.status === 'disabled'
              ? P.disabled
              : null;
  const update = !!build && (!local || local.version !== build.version);
  return (
    <article className="plugin-card" data-plugin={entry.code}>
      <span className="plugin-short" aria-hidden="true">
        {entry.short}
      </span>
      <div className="plugin-description">
        <h3>{entry.name}</h3>
        {build || local ? (
          <p>
            <span className="plugin-version">{version}</span>
            {years.length > 0 && ` · ${P.revit(years)}`}
          </p>
        ) : (
          <p>{P.noBuild}</p>
        )}
        {status && (
          <div className="plugin-work" data-phase={item?.phase ?? 'broken'} role="status">
            <p>{status}</p>
            {running && <progress aria-label={P.progress(entry.name)} />}
          </div>
        )}
        {local?.held && local.previous && <p>{P.held(local.previous)}</p>}
        {(build || local?.rollbackAvailable) && (
          <details>
            <summary>{P.notes}</summary>
            {build && (
              <>
                <p className="plugin-notes">{build.notes || P.noNotes}</p>
                {build.requires.length > 0 && (
                  <p>
                    {P.requires(
                      build.requires.map((r) => `${r.plugin} ≥ ${r.minVersion}`).join(', '),
                    )}
                  </p>
                )}
                <p>
                  {P.published(
                    build.publishedAt,
                    local?.status === 'ok' && local.version === build.version,
                  )}
                </p>
              </>
            )}
            {local?.rollbackAvailable && local.previous && (
              <button
                type="button"
                disabled={busy || running || item?.phase === 'waiting'}
                onClick={() => onAct('plugins.rollback')}
              >
                {P.rollback(local.previous)}
              </button>
            )}
          </details>
        )}
      </div>
      <span className="plugin-chip">{chip}</span>
      {build && (broken || update) && (
        <button
          type="button"
          disabled={busy || running || !available || item?.phase === 'waiting'}
          title={!available ? P.trustBlocked : undefined}
          onClick={() => onAct('plugins.install')}
        >
          {broken ? P.reinstall : revitOpen ? P.installOnClose : P.install}
        </button>
      )}
    </article>
  );
}
