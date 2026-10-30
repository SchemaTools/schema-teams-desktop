// Локальное представление; серверный договор находится в bridge/protocol.ts.
export interface ToastSpec {
  key: string;
  delayMs: number;
  id: string;
  groupId: string;
  header?: string;
  title: string;
  body: string;
  hasReply: boolean;
  buttons: string[];
}
