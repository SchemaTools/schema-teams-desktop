import { describe, expect, it } from 'vitest';
import {
  MorningNotices,
  bureauMorning,
  type MorningContext,
} from '../../src/main/notifications/morning';
import { morning as parseMorning } from '../../src/main/api/parse';
import { normalizeSettings } from '../../src/main/settings';
const context: MorningContext = {
  serverHash: 'a'.repeat(64),
  owner: 1,
  epoch: 7,
  timeZone: 'Asia/Yekaterinburg',
  now: Date.parse('2026-10-31T03:00:00Z'),
};
const summary = { date: '2026-10-31', workday: true, dueToday: 2, review: 0, newRemarks: 1 };
describe('Server-calendar morning notice', () => {
  it('uses bureau day/hour, including a server working Saturday and PC zone differences', () => {
    const notices = new MorningNotices();
    expect(notices.ticket(context, summary, [])).not.toBeNull();
    expect(notices.ticket({ ...context, timeZone: 'UTC' }, summary, [])).toBeNull();
    expect(bureauMorning(Date.parse('2026-10-30T20:00:00Z'), 'Asia/Yekaterinburg')?.date).toBe(
      '2026-10-31',
    );
    expect(notices.ticket({ ...context, now: context.now - 1 }, summary, [])).toBeNull();
  });
  it('holidays, wrong date and all-zero are valid data but never consume a showing', () => {
    const notices = new MorningNotices();
    expect(notices.ticket(context, { ...summary, workday: false }, [])).toBeNull();
    expect(notices.ticket(context, { ...summary, date: '2026-10-30' }, [])).toBeNull();
    const zero = { ...summary, dueToday: 0, review: 0, newRemarks: 0 };
    expect(parseMorning(zero)).toEqual(zero);
    expect(notices.ticket(context, zero, [])).toBeNull();
    expect(notices.ticket(context, summary, [])).not.toBeNull();
  });
  it('only actual shown consumes the day; persisted marks survive a new controller', () => {
    const notices = new MorningNotices(),
      ticket = notices.ticket(context, summary, []);
    if (!ticket) throw Error('No ticket');
    expect(notices.ticket(context, summary, [])).not.toBeNull();
    notices.shown(ticket);
    expect(notices.ticket(context, summary, [])).toBeNull();
    expect(new MorningNotices().ticket(context, summary, [ticket.key])).toBeNull();
    expect(
      new MorningNotices().ticket({ ...context, owner: 2 }, summary, [ticket.key]),
    ).not.toBeNull();
    expect(
      new MorningNotices().ticket({ ...context, serverHash: 'b'.repeat(64) }, summary, [
        ticket.key,
      ]),
    ).not.toBeNull();
    expect(notices.valid(ticket, context, [ticket.key], true)).toBe(true);
  });
  it('late previous epoch/day/zone cannot show or open the old notice', () => {
    const notices = new MorningNotices(),
      ticket = notices.ticket(context, summary, []);
    if (!ticket) throw Error('No ticket');
    for (const changed of [
      { ...context, epoch: 8 },
      { ...context, owner: 2 },
      { ...context, now: context.now + 86400000 },
      { ...context, timeZone: 'UTC' },
    ]) {
      expect(notices.valid(ticket, changed, [])).toBe(false);
      expect(notices.valid(ticket, changed, [], true)).toBe(false);
    }
  });
  it('strict parser rejects malformed counts/calendar, unknown markers cannot set a shown day', () => {
    for (const key of ['dueToday', 'review', 'newRemarks'])
      for (const value of [-1, 0.5, '1', null, []])
        expect(() => parseMorning({ ...summary, [key]: value })).toThrow();
    for (const value of ['2026-02-30', 'tomorrow', 1])
      expect(() => parseMorning({ ...summary, date: value })).toThrow();
    expect(() => parseMorning({ ...summary, workday: 'true' })).toThrow();
    const key = `${'a'.repeat(64)}:1:2026-10-31`;
    const settings = normalizeSettings({
      morningSeen: [key, key, [], `${'a'.repeat(64)}:0:2026-10-31`],
      notifications: { morning: false },
    });
    expect(settings.morningSeen).toEqual([key]);
    expect(settings.notifications.morning).toBe(false);
  });
});
