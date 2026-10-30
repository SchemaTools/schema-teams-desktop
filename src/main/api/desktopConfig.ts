import type { DesktopConfig } from '../../shared/desktopConfig';
import { utcInstant, positiveId } from '../../shared/time';
import { InvalidData, object } from './parse';

export function desktopConfig(raw: unknown): DesktopConfig {
  const x = object(raw),
    bureau = object(x.bureau),
    source = object(x.capabilities);
  if (
    typeof bureau.timeZone !== 'string' ||
    bureau.timeZone.length > 100 ||
    typeof bureau.workEnd !== 'string' ||
    !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(bureau.workEnd) ||
    !utcInstant(x.serverNow) ||
    (x.supportChatId !== null && !positiveId(x.supportChatId))
  )
    throw new InvalidData();
  try {
    new Intl.DateTimeFormat('en', { timeZone: bureau.timeZone }).format();
  } catch {
    throw new InvalidData();
  }
  const capabilities: DesktopConfig['capabilities'] = {};
  for (const key of ['chatQuiet', 'morning', 'support', 'plugins', 'timerControl'] as const) {
    const value = source[key];
    if (value !== undefined) {
      if (!positiveId(value)) throw new InvalidData();
      capabilities[key] = value;
    }
  }
  return {
    bureau: { timeZone: bureau.timeZone, workEnd: bureau.workEnd },
    serverNow: x.serverNow,
    supportChatId: x.supportChatId,
    capabilities,
  };
}
