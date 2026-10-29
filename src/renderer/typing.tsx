import { useEffect, useState } from 'react';
import type { ClientSnapshot } from '../shared/desktop';

export function TypingStatus({
  entries,
  chatId,
  online,
  fallback,
}: {
  entries: ClientSnapshot['typing'];
  chatId: number;
  online: boolean;
  fallback?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = () => {
      const stamp = Date.now();
      setNow(stamp);
      const next = online
        ? (entries?.filter((t) => t.chatId === chatId && t.until > stamp).map((t) => t.until) ?? [])
        : [];
      if (next.length) timer = setTimeout(advance, Math.max(0, Math.min(...next) - stamp + 5));
    };
    advance();
    return () => clearTimeout(timer);
  }, [entries, chatId, online]);
  const names = online
    ? (entries?.filter((t) => t.chatId === chatId && t.until > now).map((t) => t.shortName) ?? [])
    : [];
  if (!names.length) return <>{fallback}</>;
  return (
    <span className="typing-status" role="status">
      {names.slice(0, 2).join(', ')}
      {names.length > 2 ? ' и другие' : ''} {names.length === 1 ? 'печатает…' : 'печатают…'}
    </span>
  );
}
