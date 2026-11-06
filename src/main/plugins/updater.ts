import { randomUUID } from 'node:crypto';
import {
  comparePluginVersions,
  type InstalledPluginView,
  type ManagedPluginsView,
  type PluginBuild,
  type PluginCatalog,
  type PluginEntry,
  type PluginWorkItem,
  type PluginWorkflowState,
} from '../../shared/plugins';
import { planPluginYears } from './planner';
import {
  PluginInstallError,
  type InstalledPlugin,
  type PluginInstaller,
  type Year,
} from './installer';
import type { RevitProcessState } from './safety';
import { auditPlugin, type PluginAuditListener } from './audit';

/**
 * Очередь установки плагинов (ТЗ 8.3). Одна операция за раз; Revit открыт — ждём его
 * закрытия и опрашиваем процессы своего сеанса. События каталога и переподключение
 * только ставят новую проверку: начатую запись на диск они не обрывают.
 */
export interface PluginUpdaterContext {
  /** Меняется при смене входа или сервера — по нему гаснут чужие уведомления и запросы. */
  key: string;
  /** Область состояния «сервер + пользователь» (PluginInstaller.scope). */
  scope: string;
  automatic: boolean;
  beta: boolean;
  /** Доверенный издатель настроен — иначе ставить нельзя (вернуть и восстановить — можно). */
  available: boolean;
}
export interface PluginUpdaterPorts {
  context(): PluginUpdaterContext | null;
  /** Последний прочитанный каталог или null. */
  catalog(): PluginCatalog | null;
  years(): Promise<Year[]>;
  installer(): PluginInstaller;
  download(build: PluginBuild, root: string, signal: AbortSignal): Promise<string>;
  processes(): Promise<RevitProcessState>;
  /** Нельзя начинать, пока приложение передаёт управление своему обновлению. */
  mayRun(): boolean;
  changed(): void;
  audit?: PluginAuditListener;
  pollMs?: number;
  /** Снятые галочки набора для плагина (настройки компьютера). */
  deselected?(code: string): string[];
  /**
   * Доверие сертификату бюро перед установкой (импорт в «Доверенные корневые» и
   * «Доверенные издатели» пользователя). Автоматическая установка не вызывает системный
   * диалог Windows: 'required' — нужна кнопка; prompting — перед диалогом, для подсказки в окне.
   */
  ensureTrust?(o: { manual: boolean; prompting: () => void }): Promise<PluginTrustOutcome>;
  /**
   * Перед записью своего .addin при закрытом Revit: замена прежней установки Inno и
   * bureau.txt. Возвращает причину предупреждения (установка всё равно идёт) или null.
   */
  beforeCommit?(code: string, first: boolean): Promise<string | null>;
}
export type PluginTrustOutcome = 'ok' | 'required' | 'declined' | 'failed';
export interface PluginUpdateNotice {
  id: string;
  type: 'waiting' | 'complete';
  items: PluginWorkItem[];
}
type Kind = 'install' | 'rollback';
interface Work {
  code: string;
  kind: Kind;
  manual: boolean;
}
const EMPTY_VIEW: ManagedPluginsView = { available: false, recovering: false, plugins: [] };

/** Сборка для этого компьютера: пробная — испытателю с включёнными «Пробными», если новее. */
export function selectedBuild(
  entry: PluginEntry,
  catalog: PluginCatalog,
  beta: boolean,
): PluginBuild | null {
  const trial = beta && catalog.tester ? entry.beta : null;
  if (trial && (!entry.stable || comparePluginVersions(trial.version, entry.stable.version) > 0))
    return trial;
  return entry.stable ?? trial ?? null;
}

export class PluginUpdater {
  state: PluginWorkflowState = {
    phase: 'idle',
    active: false,
    revitOpen: false,
    pending: 0,
    items: [],
  };
  managed: ManagedPluginsView = EMPTY_VIEW;
  private readonly requests = new Map<string, Work>();
  private readonly failed = new Set<string>();
  private readonly tickets = new Map<
    string,
    { ticket: PluginUpdateNotice; context: string; shown: boolean }
  >();
  private waitingTicket: string | null = null;
  private contextKey: string | null = null;
  private flight?: Promise<void>;
  private again = false;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private recovering = false;
  constructor(readonly o: PluginUpdaterPorts) {}
  get busy(): boolean {
    return this.state.active;
  }
  private emitted = '';
  /** Окно обновляется только при настоящем изменении состояния. */
  private emit(): void {
    const stamp = JSON.stringify([this.state, this.managed, [...this.tickets.keys()]]);
    if (stamp === this.emitted) return;
    this.emitted = stamp;
    try {
      this.o.changed();
    } catch {
      /* Наблюдатели окна и журнала не меняют исход операции. */
    }
  }
  private audit(event: Parameters<typeof auditPlugin>[1]): void {
    auditPlugin(this.o.audit, event);
  }
  /** Смена входа или сервера: запросы и уведомления прежнего входа больше не действуют. */
  sync(): void {
    const key = this.o.context()?.key ?? null;
    if (key === this.contextKey) return;
    this.contextKey = key;
    this.requests.clear();
    this.failed.clear();
    this.tickets.clear();
    this.waitingTicket = null;
    this.state = { ...this.state, phase: 'idle', pending: 0, items: [] };
    this.managed = { ...EMPTY_VIEW, recovering: this.recovering };
    if (key) void this.refresh();
  }
  /** Запрос из окна: установить (переустановить) или вернуть предыдущую версию. */
  request(code: string, kind: Kind): { accepted: boolean; reason?: string } {
    this.sync();
    const context = this.o.context();
    if (!context) return { accepted: false, reason: 'plugin_context_unavailable' };
    if (kind === 'install' && !context.available)
      return { accepted: false, reason: 'plugin_trust_unconfigured' };
    if (kind === 'install' && !this.o.catalog()?.plugins.some((p) => p.code === code))
      return { accepted: false, reason: 'plugin_unavailable' };
    if (
      kind === 'rollback' &&
      !this.managed.plugins.some((p) => p.code === code && p.rollbackAvailable)
    )
      return { accepted: false, reason: 'rollback_unavailable' };
    this.requests.set(code, { code, kind, manual: true });
    for (const id of [...this.failed]) if (id.startsWith(`${code}:`)) this.failed.delete(id);
    void this.refresh();
    return { accepted: true };
  }
  /**
   * Смена состава набора: .addin перезаписывается из установленной папки версии без
   * загрузки. Не установлен — выбор только сохраняется и применится при установке.
   */
  async select(code: string): Promise<{ ok: boolean; reason?: string; applied?: boolean }> {
    this.sync();
    const context = this.o.context();
    if (!context) return { ok: false, reason: 'plugin_context_unavailable' };
    const local = this.managed.plugins.find((p) => p.code === code);
    if (!local?.components) return { ok: true, applied: false };
    try {
      const result = await this.op(() =>
        this.o.installer().select(context.scope, code, this.o.deselected?.(code) ?? []),
      );
      if (result === null) return { ok: false, reason: 'plugin_job_failed' };
      this.audit({
        operation: 'install',
        phase: 'result',
        outcome: 'ok',
        reason: 'selection',
        plugin: code,
      });
      await this.inspect(context.scope);
      this.emit();
      return { ok: true, applied: result === 'complete' };
    } catch (error) {
      const reason = error instanceof PluginInstallError ? error.reason : 'plugin_job_failed';
      return { ok: false, reason };
    }
  }
  /** Проверить и выполнить очередь. retryFailures — по «Проверить сейчас». */
  refresh(retryFailures = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (retryFailures) {
      this.failed.clear();
      // «Проверить» начинает с чистого листа: прежние «готово» и ошибки снимаются.
      this.state = { ...this.state, items: this.state.items.filter((i) => i.phase === 'waiting') };
    }
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.o.mayRun()) {
      this.arm(2000);
      return Promise.resolve();
    }
    const flight = Promise.resolve()
      .then(() => this.drive())
      .catch(() => {
        /* Ошибка отдельной операции уже записана в её строку. */
      })
      .finally(() => {
        if (this.flight === flight) this.flight = undefined;
        this.emit();
        if (this.again && !this.disposed) {
          this.again = false;
          void this.refresh();
        }
      });
    this.flight = flight;
    return flight;
  }
  /** Дождаться конца текущей проверки (и повторной, если её поставили по ходу). */
  async settled(): Promise<void> {
    while (this.flight) await this.flight;
  }
  /** Операция с диском или сетью: на это время updater «занят» для обновления приложения. */
  private async op<T>(work: () => Promise<T>): Promise<T | null> {
    if (!this.o.mayRun()) return null;
    this.state = { ...this.state, active: true };
    this.emit();
    try {
      return await work();
    } finally {
      this.state = { ...this.state, active: false };
      this.emit();
    }
  }
  private arm(ms: number): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, ms);
    this.timer.unref?.();
  }
  private item(work: Work, patch: Partial<PluginWorkItem>): PluginWorkItem {
    const entry = this.o.catalog()?.plugins.find((p) => p.code === work.code);
    const before = this.state.items.find((i) => i.code === work.code);
    const next: PluginWorkItem = {
      code: work.code,
      name: entry?.name ?? before?.name ?? work.code,
      version: before?.version ?? '',
      years: before?.years ?? [],
      kind: work.kind,
      phase: 'waiting',
      // Предупреждение операции (прежняя установка не удалена) держится до её конца.
      ...(before?.notice && { notice: before.notice }),
      ...patch,
    };
    if (!patch.reason) delete next.reason;
    if (!patch.detail) delete next.detail;
    if (!next.notice) delete next.notice;
    if (!patch.prompt) delete next.prompt;
    this.state = {
      ...this.state,
      items: [...this.state.items.filter((i) => i.code !== work.code), next],
    };
    this.emit();
    return next;
  }
  private async inspect(scope: string | null): Promise<InstalledPlugin[]> {
    const context = this.o.context();
    if (!scope || !context) {
      this.managed = { ...EMPTY_VIEW, recovering: this.recovering };
      return [];
    }
    const installed = await this.o.installer().inspect(scope);
    if (this.o.context()?.key === context.key)
      this.managed = {
        available: context.available,
        recovering: this.recovering,
        plugins: installed.map((p): InstalledPluginView => ({
          code: p.code,
          version: p.version,
          years: p.years,
          status: p.status,
          previous: p.previous,
          rollbackAvailable: p.rollbackAvailable,
          held: !!p.held,
          ...(p.components && { components: structuredClone(p.components) }),
        })),
      };
    return installed;
  }
  /** Что поставить само: все плагины каталога с проверенной сборкой для установленного Revit. */
  private automatic(
    catalog: PluginCatalog,
    context: PluginUpdaterContext,
    installed: InstalledPlugin[],
    years: Year[],
  ): Work[] {
    if (!context.automatic || !context.available) return [];
    const result: Work[] = [];
    for (const entry of catalog.plugins) {
      const build = selectedBuild(entry, catalog, context.beta);
      if (!build?.verified || this.failed.has(`${entry.code}:${build.id}`)) continue;
      const target = years.filter((y) => build.revit.includes(y));
      if (!target.length) continue;
      const local = installed.find((p) => p.code === entry.code);
      if (local) {
        const same = local.buildId === build.id && local.archiveSha256 === build.sha256;
        if (local.held?.buildId === build.id && local.held.archiveSha256 === build.sha256) continue;
        if (!same && comparePluginVersions(build.version, local.version) < 0) continue;
        if (same && local.status === 'ok' && target.every((y) => local.years.includes(y))) continue;
      }
      result.push({ code: entry.code, kind: 'install', manual: false });
    }
    return result;
  }
  private async drive(): Promise<void> {
    const installer = this.o.installer();
    // Незавершённая операция доводится первой — без сервера и без входа.
    if (await installer.pending()) {
      this.recovering = true;
      const result = await this.op(() => installer.recover().catch(() => 'error' as const));
      if (result === null || result === 'waiting' || result === 'error') {
        this.managed = { ...this.managed, recovering: true };
        this.state = { ...this.state, phase: 'waiting' };
        this.arm(this.o.pollMs ?? 5000);
        return;
      }
      this.recovering = false;
      this.audit({ operation: 'recovery', phase: 'result', outcome: 'ok' });
    }
    this.recovering = false;
    await installer.cleanupStaging().catch(() => {});
    this.sync();
    let context = this.o.context();
    if (!context) return;
    let installed = await this.inspect(context.scope);
    const catalog = this.o.catalog();
    let years: Year[] = [];
    try {
      years = (await this.o.years()).filter((y): y is Year => y === 2025 || y === 2026);
    } catch {
      years = [];
    }
    const queue = [
      ...[...this.requests.values()],
      ...(catalog ? this.automatic(catalog, context, installed, years) : []).filter(
        (w) => !this.requests.has(w.code),
      ),
    ];
    let waiting = false;
    const completed: PluginWorkItem[] = [];
    for (const [index, work] of queue.entries()) {
      context = this.o.context();
      if (!context || context.key !== this.contextKey || !this.o.mayRun()) break;
      if (!waiting && !(await this.revitIdle())) waiting = true;
      if (waiting) {
        for (const w of queue.slice(index)) this.markWaiting(w, catalog, installed);
        break;
      }
      // Зависимость, поставленная предыдущей операцией, второй раз не ставится.
      if (
        !work.manual &&
        !(
          catalog &&
          this.automatic(catalog, context, installed, years).some((w) => w.code === work.code)
        )
      )
        continue;
      const active = context;
      const outcome = await this.op(() => this.run(work, active, catalog, installed, years));
      if (outcome === null) break;
      if (outcome === 'waiting') {
        waiting = true;
        for (const w of queue.slice(index)) this.markWaiting(w, catalog, installed);
        break;
      }
      this.requests.delete(work.code);
      const item = this.state.items.find((i) => i.code === work.code);
      if (outcome === 'complete' && item && work.kind === 'install') completed.push(item);
      installed = await this.inspect(context.scope);
    }
    this.state = {
      ...this.state,
      phase: waiting ? 'waiting' : 'idle',
      pending: waiting ? this.state.items.filter((i) => i.phase === 'waiting').length : 0,
    };
    if (waiting) {
      this.addWaitingNotice();
      this.arm(this.o.pollMs ?? 5000);
    } else this.waitingTicket = null;
    if (completed.length) this.addNotice('complete', completed);
    await installer.cleanup().catch(() => {});
  }
  private async revitIdle(): Promise<boolean> {
    const idle = (await this.o.processes().catch(() => 'unknown' as const)) === 'idle';
    this.state = { ...this.state, revitOpen: !idle };
    return idle;
  }
  private markWaiting(
    work: Work,
    catalog: PluginCatalog | null,
    installed: InstalledPlugin[],
  ): void {
    const entry = catalog?.plugins.find((p) => p.code === work.code),
      context = this.o.context(),
      build =
        entry && context ? selectedBuild(entry, catalog as PluginCatalog, context.beta) : null,
      local = installed.find((p) => p.code === work.code);
    this.item(work, {
      phase: 'waiting',
      version: work.kind === 'rollback' ? (local?.previous ?? '') : (build?.version ?? ''),
      from: local?.version,
      years: build?.revit.filter((y): y is Year => y === 2025 || y === 2026) ?? local?.years ?? [],
    });
    if (work.manual) this.requests.set(work.code, work);
  }
  /** Одна операция. Ошибки — в строку плагина и в журнал, без исключений наружу. */
  private async run(
    work: Work,
    context: PluginUpdaterContext,
    catalog: PluginCatalog | null,
    installed: InstalledPlugin[],
    years: Year[],
  ): Promise<'complete' | 'waiting' | 'error'> {
    const installer = this.o.installer(),
      local = installed.find((p) => p.code === work.code);
    let failedBuild: number | null = null;
    try {
      if (work.kind === 'rollback') {
        this.item(work, {
          phase: 'installing',
          version: local?.previous ?? '',
          from: local?.version,
          years: local?.years ?? [],
          notice: undefined,
        });
        this.audit({ operation: 'rollback', phase: 'requested', plugin: work.code });
        const result = await installer.rollback(
          context.scope,
          work.code,
          this.o.deselected?.(work.code),
        );
        if (result === 'waiting') return 'waiting';
        this.item(work, {
          phase: 'complete',
          version: local?.previous ?? '',
          years: local?.years ?? [],
        });
        this.audit({
          operation: 'rollback',
          phase: 'result',
          outcome: 'ok',
          plugin: work.code,
          version: local?.previous ?? undefined,
          previous: local?.version,
        });
        return 'complete';
      }
      const entry = catalog?.plugins.find((p) => p.code === work.code);
      const build = entry && catalog ? selectedBuild(entry, catalog, context.beta) : null;
      if (!entry || !catalog || !build) throw new PluginInstallError('plugin_unavailable');
      failedBuild = build.id;
      const target = years.filter((y) => build.revit.includes(y));
      if (!target.length) throw new PluginInstallError('revit_not_found');
      this.item(work, {
        phase: 'installing',
        version: build.version,
        from: local?.version,
        years: target,
        notice: undefined,
      });
      // Зависимости (Schema.Tools) — первыми; несовместимое сочетание не ставится.
      let plans;
      try {
        plans = planPluginYears(catalog, work.code, target, context.beta && catalog.tester);
      } catch {
        throw new PluginInstallError('plugin_dependency_unavailable');
      }
      const order: { code: string; build: PluginBuild; years: Year[] }[] = [];
      for (const plan of plans)
        for (const step of plan.builds) {
          const known = order.find((o) => o.code === step.code);
          if (known && known.build.id !== step.build.id)
            throw new PluginInstallError('plugin_dependency_unavailable');
          if (known) known.years.push(plan.year);
          else order.push({ code: step.code, build: step.build, years: [plan.year] });
        }
      for (const step of order) {
        const main = step.code === work.code,
          have = installed.find((p) => p.code === step.code);
        if (!main) {
          const required = build.requires.find((r) => r.plugin === step.code);
          if (
            have?.status === 'ok' &&
            step.years.every((y) => have.years.includes(y)) &&
            (!required || comparePluginVersions(have.version, required.minVersion) >= 0)
          )
            continue;
        }
        if (!context.available) throw new PluginInstallError('plugin_trust_unconfigured');
        // Файлы версии целы, пропал только .addin — переустановка без загрузки.
        if (
          have &&
          have.buildId === step.build.id &&
          have.archiveSha256 === step.build.sha256 &&
          have.status === 'disabled' &&
          step.years.every((y) => have.years.includes(y))
        ) {
          const repaired = await installer.repair(context.scope, step.code);
          if (repaired === 'waiting') return 'waiting';
          if (repaired === 'complete') continue;
        }
        const result = await this.installBuild(work, context, step, have);
        if (result === 'waiting') return 'waiting';
      }
      this.item(work, {
        phase: 'complete',
        version: build.version,
        from: local?.version,
        years: target,
      });
      return 'complete';
    } catch (error) {
      const reason = error instanceof PluginInstallError ? error.reason : 'plugin_job_failed';
      const detail = error instanceof PluginInstallError ? error.detail : undefined;
      if (failedBuild !== null) this.failed.add(`${work.code}:${failedBuild}`);
      this.item(work, { phase: 'error', reason, detail });
      this.audit({
        operation: work.kind,
        phase: 'result',
        outcome: 'rejected',
        reason,
        plugin: work.code,
      });
      return 'error';
    }
  }
  private async installBuild(
    work: Work,
    context: PluginUpdaterContext,
    step: { code: string; build: PluginBuild; years: Year[] },
    have: InstalledPlugin | undefined,
  ): Promise<'complete' | 'waiting'> {
    const installer = this.o.installer();
    this.audit({
      operation: 'install',
      phase: 'requested',
      plugin: step.code,
      version: step.build.version,
      buildId: step.build.id,
    });
    if (this.o.ensureTrust) {
      const trust = await this.o
        .ensureTrust({
          manual: work.manual,
          prompting: () => this.item(work, { phase: 'installing', prompt: 'certificate' }),
        })
        .catch((): PluginTrustOutcome => 'failed');
      if (trust !== 'ok') {
        this.audit({
          operation: 'install',
          phase: 'result',
          outcome: 'rejected',
          reason: `certificate_${trust}`,
          plugin: step.code,
        });
        throw new PluginInstallError(`certificate_${trust}`);
      }
    }
    if (step.code === work.code) this.item(work, { phase: 'downloading' });
    const abort = new AbortController();
    let archive: string;
    try {
      await installer.cleanupStaging();
      archive = await this.o.download(step.build, installer.stagingRoot, abort.signal);
    } catch {
      throw new PluginInstallError('download');
    }
    if (step.code === work.code) this.item(work, { phase: 'installing' });
    const prepared = await installer.prepare({
      scope: context.scope,
      code: step.code,
      build: step.build,
      archivePath: archive,
      years: step.years,
      deselected: this.o.deselected?.(step.code),
    });
    try {
      // Сборку отозвали, пока качали, — ставить её уже не нужно.
      const latest = this.o.catalog()?.plugins.find((p) => p.code === step.code);
      if (latest && latest.stable?.id !== step.build.id && latest.beta?.id !== step.build.id)
        throw new PluginInstallError('plugin_unavailable');
      // Прежняя установка Inno и bureau.txt — при закрытом Revit, до записи своего .addin.
      if (this.o.beforeCommit && (await this.revitIdle())) {
        const warning = await this.o
          .beforeCommit(step.code, !have)
          .catch(() => 'legacy_failed' as const);
        if (warning) {
          this.item(work, { phase: 'installing', notice: warning });
          this.audit({
            operation: 'install',
            phase: 'waiting',
            reason: warning,
            plugin: step.code,
          });
        }
      }
      const result = await installer.commit(prepared);
      if (result === 'complete')
        this.audit({
          operation: 'install',
          phase: 'result',
          outcome: 'ok',
          plugin: step.code,
          version: step.build.version,
          previous: have?.version,
          buildId: step.build.id,
        });
      else
        this.audit({
          operation: 'install',
          phase: 'waiting',
          reason: 'revit_busy',
          plugin: step.code,
        });
      return result;
    } finally {
      await installer.discard(prepared);
      await installer.cleanupStaging().catch(() => {});
    }
  }

  // ── уведомления (ТЗ 5.3) ──────────────────────────────────────────────
  private addWaitingNotice(): void {
    const items = this.state.items.filter((i) => i.phase === 'waiting' && i.kind === 'install');
    if (!items.length) return;
    const stamp = JSON.stringify(items.map((i) => [i.code, i.version]));
    const current = this.waitingTicket ? this.tickets.get(this.waitingTicket) : undefined;
    if (current && JSON.stringify(current.ticket.items.map((i) => [i.code, i.version])) === stamp)
      return;
    this.waitingTicket = this.addNotice('waiting', items);
  }
  private addNotice(type: PluginUpdateNotice['type'], items: PluginWorkItem[]): string | null {
    const context = this.contextKey;
    if (!context) return null;
    const ticket: PluginUpdateNotice = { id: randomUUID(), type, items: structuredClone(items) };
    this.tickets.set(ticket.id, { ticket, context, shown: false });
    while (this.tickets.size > 16) this.tickets.delete(this.tickets.keys().next().value as string);
    return ticket.id;
  }
  pendingNotices(): PluginUpdateNotice[] {
    return [...this.tickets.values()]
      .filter((t) => !t.shown && this.noticeCurrent(t.ticket))
      .map((t) => structuredClone(t.ticket));
  }
  noticeCurrent(ticket: PluginUpdateNotice): boolean {
    const stored = this.tickets.get(ticket.id);
    return (
      !this.disposed &&
      !!stored &&
      stored.context === this.o.context()?.key &&
      (ticket.type === 'complete' || (this.waitingTicket === ticket.id && this.state.pending > 0))
    );
  }
  shown(ticket: PluginUpdateNotice): void {
    const stored = this.tickets.get(ticket.id);
    if (stored && this.noticeCurrent(ticket)) stored.shown = true;
  }
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tickets.clear();
  }
}
