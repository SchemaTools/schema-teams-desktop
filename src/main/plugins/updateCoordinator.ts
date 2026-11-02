import { randomUUID } from 'node:crypto';
import {
  comparePluginVersions,
  type ManagedPluginsView,
  type PluginCatalog,
  type PluginBuild,
  type PluginWorkItem,
  type PluginWorkflowState,
} from '../../shared/plugins';
import { pluginCatalog } from '../api/plugins';
import { planPluginYears } from './planner';
import { pluginPlanSafety, type AutomaticPluginAdmission } from './planSafety';
import type { PluginTransactionResult } from './transactionTypes';
import type { RevitProcessState } from './safety';

type Year = 2025 | 2026;
export interface PluginUpdateContext {
  key: string;
  automatic: boolean;
  beta: boolean;
}
export interface PluginUpdateNotice {
  id: string;
  intent: string;
  type: 'waiting' | 'complete';
  item: PluginWorkItem;
}
export interface PluginUpdatePorts {
  context(): PluginUpdateContext | null;
  mayRun(): boolean;
  inspect(): Promise<ManagedPluginsView>;
  years(): Promise<Year[]>;
  catalog(): Promise<PluginCatalog>;
  install(
    code: string,
    years: Year[],
    verifiedOnly: boolean,
    automatic?: AutomaticPluginAdmission,
  ): Promise<PluginTransactionResult>;
  recover(): Promise<PluginTransactionResult>;
  processes(): Promise<RevitProcessState>;
  cancel(): void;
  changed(): void;
  automaticHeld?: (rootsHash: string, code: string, year: Year, build: PluginBuild) => boolean;
}
interface Intent {
  code: string;
  years: Year[];
  manual: boolean;
  recover: boolean;
  key?: string;
}
interface Candidate {
  automatic: AutomaticPluginAdmission;
  key: string;
  item: PluginWorkItem;
  intent: Intent;
}
const EMPTY: PluginWorkflowState = { phase: 'idle', active: false, pending: 0, items: [] };

/** Main lifecycle only. Stores an intent while Revit is busy, never a prepared
 * plan or a persisted permission. Every idle retry traverses all admission again. */
export class PluginUpdateCoordinator {
  state: PluginWorkflowState = structuredClone(EMPTY);
  private contextKey: string | null = null;
  private generation = 0;
  private disposed = false;
  private flight?: Promise<void>;
  private watching = false;
  private timer?: NodeJS.Timeout;
  private again = false;
  private readonly waiting = new Map<string, Intent>();
  private readonly failed = new Set<string>();
  private readonly completed = new Set<string>();
  private readonly tickets = new Map<
    string,
    { ticket: PluginUpdateNotice; context: string; shown: boolean }
  >();
  private currentItem?: PluginWorkItem;
  private currentKey?: string;
  constructor(private readonly o: PluginUpdatePorts) {}
  private emit(): void {
    try {
      this.o.changed();
    } catch {
      /* UI/logging observers never change a verified job outcome. */
    }
  }
  get busy(): boolean {
    return this.state.active;
  }
  sync(): void {
    const context = this.o.context();
    const key = context?.key ?? null;
    if (key === this.contextKey) return;
    this.invalidate();
    this.contextKey = key;
    if (context?.automatic)
      queueMicrotask(() => {
        if (!this.disposed) void this.refresh();
      });
  }
  invalidate(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.waiting.clear();
    this.failed.clear();
    this.completed.clear();
    this.tickets.clear();
    this.currentItem = undefined;
    // The old flight owns its slot until its await/finally unwinds. It must not
    // make an updater handoff look quiescent while the core still owns bytes.
    this.state = { ...structuredClone(EMPTY), active: !!this.flight };
    this.o.cancel();
  }
  phase(phase: 'checking' | 'downloading' | 'installing'): void {
    if (!this.state.active || !this.currentItem) return;
    this.currentItem.phase = phase;
    this.state.phase = 'running';
    this.emit();
  }
  refresh(retryFailures = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.sync();
    const context = this.o.context();
    if (!context || (!context.automatic && !this.waiting.size)) return Promise.resolve();
    if (retryFailures) this.failed.clear();
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    if (!this.o.mayRun()) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.refresh();
      }, 2000);
      this.timer.unref?.();
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    const generation = this.generation,
      key = context.key;
    const current = () =>
      !this.disposed &&
      generation === this.generation &&
      this.o.context()?.key === key &&
      this.o.mayRun();
    this.state.active = true;
    this.state.phase = 'checking';
    // Defer execution so the flight slot is installed before any sync callback.
    const flight = Promise.resolve()
      .then(() => this.drive(context, current))
      .catch(() => {
        if (current()) {
          this.state.phase = 'error';
          this.waiting.clear();
          if (this.currentKey) this.failed.add(this.currentKey);
          if (this.currentItem) {
            this.currentItem.phase = 'error';
            this.currentItem.reason = 'plugin_job_failed';
          }
        }
      })
      .finally(() => {
        if (this.flight !== flight) return;
        this.flight = undefined;
        this.state.active = false;
        this.currentItem = undefined;
        this.currentKey = undefined;
        this.state.pending = this.waiting.size;
        if (this.waiting.size) this.state.phase = 'waiting';
        else if (this.state.phase === 'running' || this.state.phase === 'checking')
          this.state.phase = 'idle';
        this.emit();
        if (this.again) {
          this.again = false;
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh();
          }, 0);
          this.timer.unref?.();
        } else this.arm();
      });
    this.flight = flight;
    this.emit();
    return flight;
  }
  async manual(
    code: string,
    years: Year[],
  ): Promise<{ accepted: boolean; waiting?: boolean; reason?: string }> {
    this.sync();
    if (this.disposed || !this.o.context() || !this.o.mayRun())
      return { accepted: false, reason: 'plugin_context_unavailable' };
    if (this.flight) return { accepted: false, reason: 'busy' };
    const generation = this.generation;
    this.state.items = this.state.items.filter((i) => i.code !== code);
    this.waiting.set(code, { code, years: [...years], manual: true, recover: false });
    this.failed.clear();
    await this.refresh();
    if (generation !== this.generation) return { accepted: false, reason: 'stale_plugin_job' };
    const item = this.state.items.find((x) => x.code === code);
    if (this.waiting.has(code)) return { accepted: true, waiting: true };
    return {
      accepted: item?.phase === 'complete',
      reason: item?.phase === 'complete' ? undefined : (item?.reason ?? 'plugin_job_failed'),
    };
  }
  private candidates(
    catalog: PluginCatalog,
    years: Year[],
    local: ManagedPluginsView,
    context: PluginUpdateContext,
  ): Candidate[] {
    const result: Candidate[] = [];
    const evidence = local.packages.map((p) => ({
      plugin: p.code,
      version: p.version,
      years: p.years,
    }));
    const intents: Intent[] = [...this.waiting.values()].filter((i) => i.manual);
    if (context.automatic)
      for (const p of catalog.plugins)
        if (!intents.some((i) => i.code === p.code))
          intents.push({
            code: p.code,
            years: [...years],
            manual: false,
            recover: this.waiting.get(p.code)?.recover ?? false,
          });
    for (const intent of intents) {
      const entry = catalog.plugins.find((p) => p.code === intent.code);
      if (!entry) {
        this.waiting.delete(intent.code);
        continue;
      }
      const allowedYears = intent.years.filter(
        (y) =>
          years.includes(y) &&
          [
            ...(context.beta && catalog.tester && entry.beta ? [entry.beta] : []),
            ...(entry.stable ? [entry.stable] : []),
          ].some((b) => b.revit.includes(y)),
      );
      if (intent.manual && allowedYears.length !== intent.years.length) {
        this.waiting.delete(intent.code);
        this.state.items.push({
          code: intent.code,
          name: entry.name,
          version: '',
          years: intent.years,
          phase: 'error',
          reason: 'revit_inventory_changed',
        });
        continue;
      }
      if (!allowedYears.length) {
        this.waiting.delete(intent.code);
        continue;
      }
      try {
        const plans = planPluginYears(catalog, intent.code, allowedYears, context.beta, evidence);
        if (!intent.manual && plans.some((p) => p.builds.some((b) => !b.build.verified))) continue;
        if (
          !intent.manual &&
          plans.some((p) =>
            p.builds.some((b) =>
              local.packages.some(
                (installed) =>
                  installed.code === b.code &&
                  installed.years.includes(p.year) &&
                  comparePluginVersions(installed.version, b.build.version) > 0,
              ),
            ),
          )
        )
          continue;
        if (
          !intent.manual &&
          this.o.automaticHeld &&
          plans.some((p) =>
            p.builds.some(
              (b) =>
                !local.packages.some(
                  (i) =>
                    i.code === b.code &&
                    i.years.includes(p.year) &&
                    i.buildId === b.build.id &&
                    i.archiveSha256 === b.build.sha256,
                ) &&
                (!local.rootsHash ||
                  this.o.automaticHeld?.(local.rootsHash, b.code, p.year, b.build)),
            ),
          )
        ) {
          this.waiting.delete(intent.code);
          this.state.items = [
            ...this.state.items.filter((i) => i.code !== intent.code),
            {
              code: intent.code,
              name: entry.name,
              version: '',
              years: allowedYears,
              phase: 'error',
              reason: 'automatic_rollback_hold',
            },
          ];
          continue;
        }
        const roots = plans.map((p) => ({
          year: p.year,
          build: p.builds.find((b) => b.code === intent.code)?.build,
        }));
        const needed = roots
          .filter(({ year, build }) => {
            if (!build) return false;
            const installed = local.packages.find(
              (p) => p.code === intent.code && p.years.includes(year),
            );
            if (
              !intent.manual &&
              installed &&
              comparePluginVersions(installed.version, build.version) > 0
            )
              return false;
            return (
              plans
                .find((p) => p.year === year)
                ?.builds.some(
                  (b) =>
                    !local.packages.some(
                      (p) =>
                        p.code === b.code &&
                        p.years.includes(year) &&
                        p.buildId === b.build.id &&
                        p.archiveSha256 === b.build.sha256,
                    ),
                ) ?? false
            );
          })
          .map((x) => x.year);
        if (!needed.length) {
          this.waiting.delete(intent.code);
          if (intent.manual)
            this.state.items = [
              ...this.state.items.filter((i) => i.code !== intent.code),
              {
                code: intent.code,
                name: entry.name,
                version: [...new Set(roots.map((r) => r.build?.version ?? ''))].join(' / '),
                years: allowedYears,
                phase: 'complete',
                reason: 'already_installed',
              },
            ];
          continue;
        }
        const safety = plans.map((p) => ({
          year: p.year,
          builds: p.builds.map(({ code, build: b }) => ({
            code,
            id: b.id,
            version: b.version,
            sha256: b.sha256,
            size: b.size,
            url: b.url,
            revit: b.revit,
            verified: b.verified,
            requires: b.requires,
          })),
        }));
        const key = JSON.stringify([context.key, intent.code, needed, intent.manual, safety]);
        result.push({
          automatic: {
            currentId: local.receiptId,
            safety: pluginPlanSafety(
              plans.filter((p) => needed.includes(p.year)),
              catalog,
            ),
          },
          key,
          intent: { ...intent, years: needed },
          item: {
            code: intent.code,
            name: entry.name,
            version: [
              ...new Set(
                roots.filter((r) => needed.includes(r.year)).map((r) => r.build?.version ?? ''),
              ),
            ].join(' / '),
            years: needed,
            phase: 'checking',
          },
        });
      } catch {
        this.waiting.delete(intent.code);
        this.state.items = [
          ...this.state.items.filter((i) => i.code !== intent.code),
          {
            code: intent.code,
            name: entry.name,
            version: '',
            years: allowedYears,
            phase: 'error',
            reason: 'plugin_dependency_unavailable',
          },
        ];
      }
    }
    return result;
  }
  private async drive(context: PluginUpdateContext, current: () => boolean): Promise<void> {
    if (!current()) return;
    let local = await this.o.inspect();
    if (!current()) return;
    if (local.status === 'recovery' && [...this.waiting.values()].some((i) => i.recover)) {
      const recovered = await this.o.recover();
      if (!current()) return;
      if (
        recovered.status === 'waiting' ||
        (recovered.status !== 'complete' && recovered.processInterruption)
      ) {
        for (const [code] of this.waiting) {
          const item = this.state.items.find((i) => i.code === code);
          if (item) {
            item.phase = 'waiting';
            item.reason = recovered.reason;
          }
        }
        this.state.phase = 'waiting';
        return;
      }
      if (
        recovered.status !== 'complete' &&
        !(recovered.status === 'blocked' && recovered.reason === 'rolled_back_empty')
      ) {
        for (const [code] of this.waiting) {
          const item = this.state.items.find((i) => i.code === code);
          if (item) {
            item.phase = 'error';
            item.reason = 'plugin_recovery_required';
          }
        }
        this.waiting.clear();
        this.state.phase = 'error';
        return;
      }
      local = await this.o.inspect();
      if (!current()) return;
    }
    if (local.status !== 'ready' || !local.installationAvailable) {
      this.state.phase = 'unavailable';
      this.waiting.clear();
      this.state.items = [];
      return;
    }
    const years = await this.o.years();
    if (!current()) return;
    if (!years.length) {
      this.state.phase = 'unavailable';
      this.waiting.clear();
      return;
    }
    const catalog = pluginCatalog(await this.o.catalog());
    if (!current()) return;
    const candidates = this.candidates(catalog, years, local, context);
    for (const [code] of this.waiting)
      if (
        !candidates.some(
          (c) => c.intent.code === code && !this.failed.has(c.key) && !this.completed.has(c.key),
        )
      ) {
        this.waiting.delete(code);
        const item = this.state.items.find((i) => i.code === code);
        if (item?.phase === 'waiting') {
          item.phase = 'error';
          item.reason = 'plugin_candidate_unavailable';
        }
      }
    const next = candidates.find((c) => !this.failed.has(c.key) && !this.completed.has(c.key));
    if (!next) return;
    this.currentItem = next.item;
    this.currentKey = next.key;
    this.state.items = [...this.state.items.filter((i) => i.code !== next.item.code), next.item];
    this.emit();
    const freshYears = await this.o.years();
    if (!current()) return;
    if (next.intent.years.some((y) => !freshYears.includes(y))) {
      next.item.phase = 'error';
      next.item.reason = 'revit_inventory_changed';
      this.waiting.delete(next.intent.code);
      this.failed.add(next.key);
      this.state.phase = 'error';
      return;
    }
    const result = await this.o.install(
      next.intent.code,
      [...next.intent.years],
      !next.intent.manual,
      !next.intent.manual ? next.automatic : undefined,
    );
    if (!current()) return;
    if (
      result.status === 'waiting' ||
      (result.status !== 'complete' && result.processInterruption)
    ) {
      // All queued automatic candidates wait on the same Revit processes. Only
      // explicitly selected manual candidates survive when automatic is off.
      for (const c of candidates.filter(
        (c) => !this.failed.has(c.key) && !this.completed.has(c.key),
      )) {
        const intent = {
          ...c.intent,
          key: c.key,
          recover: c.intent.recover || (c.key === next.key && result.processInterruption === true),
        };
        this.waiting.set(intent.code, intent);
        const item = { ...c.item, phase: 'waiting' as const, reason: result.reason };
        this.state.items = [...this.state.items.filter((i) => i.code !== item.code), item];
        this.addNotice(c.key, 'waiting', item, context.key);
      }
      return;
    }
    this.waiting.delete(next.intent.code);
    if (result.status === 'complete') {
      next.item.phase = 'complete';
      this.completed.add(next.key);
      this.addNotice(next.key, 'complete', next.item, context.key);
    } else {
      next.item.phase = 'error';
      next.item.reason = result.reason;
      this.failed.add(next.key);
      this.state.phase = 'error';
    }
    this.again = candidates.some((c) => !this.failed.has(c.key) && !this.completed.has(c.key));
  }
  private arm(): void {
    if (this.disposed || !this.waiting.size || this.timer || this.flight || this.watching) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, 2000);
    this.timer.unref?.();
  }
  private async poll(): Promise<void> {
    if (this.disposed || this.flight || this.watching || !this.waiting.size) return;
    if (!this.o.context() || !this.o.mayRun()) {
      this.arm();
      return;
    }
    const generation = this.generation,
      key = this.o.context()?.key;
    this.watching = true;
    let idle = false;
    try {
      idle = (await this.o.processes()) === 'idle';
    } catch {
      /* Unknown never means idle. */
    } finally {
      this.watching = false;
    }
    if (this.disposed || generation !== this.generation || this.o.context()?.key !== key) {
      // Only release A's read slot; current B may have acquired a waiting intent.
      this.arm();
      return;
    }
    if (idle && this.o.mayRun()) void this.refresh();
    else this.arm();
  }
  private addNotice(
    intent: string,
    type: PluginUpdateNotice['type'],
    item: PluginWorkItem,
    context: string,
  ): void {
    if (
      [...this.tickets.values()].some((t) => t.ticket.intent === intent && t.ticket.type === type)
    )
      return;
    const ticket = { id: randomUUID(), intent, type, item: structuredClone(item) };
    this.tickets.set(ticket.id, { ticket, context, shown: false });
    while (this.tickets.size > 32) this.tickets.delete(this.tickets.keys().next().value as string);
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
      JSON.stringify(stored.ticket) === JSON.stringify(ticket) &&
      (ticket.type === 'complete'
        ? this.completed.has(ticket.intent)
        : this.waiting.get(ticket.item.code)?.key === ticket.intent)
    );
  }
  shown(ticket: PluginUpdateNotice): void {
    if (this.noticeCurrent(ticket)) {
      const stored = this.tickets.get(ticket.id);
      if (stored) stored.shown = true;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
  }
}
