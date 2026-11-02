import { createContext, useContext, useLayoutEffect, useRef } from 'react';
export const UpdateEditors = createContext<(id: symbol, busy: boolean | null) => void>(() => {});
/** An open local editor must be closed through its normal UI before updating. */
export function useUpdateEditor(open: boolean, busy: boolean): void {
  const register = useContext(UpdateEditors),
    id = useRef(Symbol('editor'));
  useLayoutEffect(() => {
    register(id.current, open || busy ? busy : null);
    return () => register(id.current, null);
  }, [register, open, busy]);
}
