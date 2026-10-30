/** Read-only projection of Teams 0.12.1 desktop-config.ts. */
export interface DesktopConfig {
  bureau: { timeZone: string; workEnd: string };
  serverNow: string;
  supportChatId: number | null;
  capabilities: Partial<
    Record<'chatQuiet' | 'morning' | 'support' | 'plugins' | 'timerControl', number>
  >;
}
