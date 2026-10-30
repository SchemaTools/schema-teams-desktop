export const REALTIME_EVENTS = [
  'desktop:plugins',
  'notification',
  'chat:message',
  'chat:update',
  'chat:read',
  'chat:list',
  'chat:reaction',
  'chat:typing',
  'chat:pin',
  'chat:poll',
  'chat:stickers',
  'chat:presence',
  'time:timer',
  'session',
  'focus',
] as const;
export type RealtimeEvent = (typeof REALTIME_EVENTS)[number];
