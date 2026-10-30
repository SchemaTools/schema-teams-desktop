import { describe, expect, it, vi } from 'vitest';
import { desktopConfig } from '../../src/main/api/desktopConfig';
import { TeamsApi, type TeamsApiOptions } from '../../src/main/api/client';
import { configFixture, timerPushFixture, timerFixture } from '../fixtures/time';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const me = (id = 1) => ({
  user: { id, shortName: 'Тест', mustChangePassword: false },
  csrfToken: 'fixture-csrf',
});
describe('Desktop config: strict values, main-only owner/epoch cache', () => {
  it('projects known fields and ignores unknown capability names', () => {
    expect(
      desktopConfig({
        ...configFixture(),
        secret: 'discard',
        capabilities: { timerControl: 2, nextFeature: { secret: true } },
      }),
    ).toEqual(configFixture());
  });
  it.each([
    { bureau: { timeZone: 'Bad/Zone', workEnd: '18:00' } },
    { bureau: { timeZone: 'Asia/Yekaterinburg', workEnd: '24:00' } },
    { serverNow: 'bad' },
    { serverNow: '2026-10-29T04:40:00' },
    { supportChatId: -1 },
    { capabilities: { timerControl: '2' } },
  ])('rejects malformed config %j', (patch) =>
    expect(() => desktopConfig({ ...configFixture(), ...patch })).toThrow(),
  );
  it.each([undefined, 1])(
    'missing/unsupported capability %s leaves control disabled',
    async (version) => {
      const fetch = vi
        .fn<TeamsApiOptions['fetch']>()
        .mockResolvedValueOnce(json(me()))
        .mockResolvedValueOnce(
          json({
            ...configFixture(),
            capabilities: version === undefined ? {} : { timerControl: version },
          }),
        );
      const api = new TeamsApi({ fetch });
      await api.authenticate();
      await api.readDesktopConfig();
      expect(api.timerControl).toBe(false);
      expect(await api.timerStart(21, null)).toMatchObject({ code: 'precondition_required' });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it('old server 404 and invalid config clear previously verified capabilities', async () => {
    const fetch = vi
      .fn<TeamsApiOptions['fetch']>()
      .mockResolvedValueOnce(json(me()))
      .mockResolvedValueOnce(json(configFixture()))
      .mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    const api = new TeamsApi({ fetch });
    await api.authenticate();
    await api.readDesktopConfig();
    expect(api.timerControl).toBe(true);
    await api.readDesktopConfig();
    expect(api.desktopConfiguration).toBeNull();
    expect(api.timerControl).toBe(false);
  });
  it('a late previous-login config cannot populate the new owner cache', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    const fetch = vi
      .fn<TeamsApiOptions['fetch']>()
      .mockResolvedValueOnce(json(me()))
      .mockReturnValueOnce(pending);
    const api = new TeamsApi({ fetch });
    await api.authenticate();
    const read = api.readDesktopConfig();
    api.clear();
    fetch.mockResolvedValueOnce(json(me(2)));
    await api.authenticate();
    resolve(json(configFixture()));
    expect(await read).toMatchObject({ code: 'stale_session' });
    expect(api.timerControl).toBe(false);
    expect(api.owner).toBe(2);
  });
});

it('capability >=2 is monotonic but still requires a valid decoded CAS snapshot', async () => {
  const fetch = vi
    .fn<TeamsApiOptions['fetch']>()
    .mockResolvedValueOnce(json(me()))
    .mockResolvedValueOnce(json({ ...configFixture(), capabilities: { timerControl: 3 } }))
    .mockResolvedValueOnce(json(timerPushFixture(timerFixture())))
    .mockResolvedValueOnce(json({ timer: null }));
  const api = new TeamsApi({ fetch });
  await api.authenticate();
  await api.readDesktopConfig();
  expect(api.timerControl).toBe(true);
  expect(await api.timer()).toMatchObject({ ok: true, data: { timerId: 71, version: 1 } });
  expect(await api.timer()).toMatchObject({ code: 'invalid_data' });
});
