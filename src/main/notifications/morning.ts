import type { MorningSummary } from '../../shared/morning';
import { isoDay } from '../../shared/time';
export interface MorningContext {
  serverHash: string;
  owner: number;
  epoch: number;
  timeZone: string;
  now: number;
}
export interface MorningTicket {
  key: string;
  context: Omit<MorningContext, 'now'>;
  summary: MorningSummary;
}
export function bureauMorning(
  now: number,
  timeZone: string,
): { date: string; afterEight: boolean } | null {
  if (!Number.isFinite(now)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(now));
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    return isoDay(date) ? { date, afterEight: Number(get('hour')) >= 8 } : null;
  } catch {
    return null;
  }
}
/** Calendar/counts are server data; Windows weekday/local clock are never consulted. */
export class MorningNotices {
  private shownHere = new Set<string>();
  ticket(
    context: MorningContext,
    summary: MorningSummary,
    persisted: readonly string[],
  ): MorningTicket | null {
    const clock = bureauMorning(context.now, context.timeZone);
    const key = `${context.serverHash}:${context.owner}:${summary.date}`;
    if (
      ![summary.dueToday, summary.review, summary.newRemarks].some((n) => n > 0) ||
      !clock?.afterEight ||
      clock.date !== summary.date ||
      !summary.workday ||
      persisted.includes(key) ||
      this.shownHere.has(key)
    )
      return null;
    return {
      key,
      context: {
        serverHash: context.serverHash,
        owner: context.owner,
        epoch: context.epoch,
        timeZone: context.timeZone,
      },
      summary: structuredClone(summary),
    };
  }
  valid(
    ticket: MorningTicket,
    context: MorningContext,
    persisted: readonly string[],
    shownAction = false,
  ): boolean {
    const old = ticket.context;
    if (
      old.serverHash !== context.serverHash ||
      old.owner !== context.owner ||
      old.epoch !== context.epoch ||
      old.timeZone !== context.timeZone
    )
      return false;
    const clock = bureauMorning(context.now, context.timeZone);
    return (
      !!clock?.afterEight &&
      clock.date === ticket.summary.date &&
      ticket.summary.workday &&
      (shownAction || (!persisted.includes(ticket.key) && !this.shownHere.has(ticket.key)))
    );
  }
  shown(ticket: MorningTicket): void {
    this.shownHere.add(ticket.key);
    while (this.shownHere.size > 128) {
      const first = this.shownHere.values().next().value;
      if (first === undefined) break;
      this.shownHere.delete(first);
    }
  }
}
