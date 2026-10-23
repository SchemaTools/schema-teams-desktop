import { S } from '../strings';
import { elapsed, focusOn, hoursMinutes, type DesktopState } from './state';

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
export function menuPage(state: DesktopState, version: string): string {
  const button = (action: string, label: string, disabled = false) =>
    `<button data-action="${action}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
  const available = state.ready && state.online && state.user !== null;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>${esc(S.desktopMenuTitle)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#1f232b;color:#f2f4f5;font:13px/1.45 "Segoe UI",Arial,sans-serif}main{padding:12px;max-height:100vh;overflow:auto}header{border-bottom:1px solid #424955;padding-bottom:10px;margin-bottom:8px}strong{font-weight:600}.muted{color:#bbc3d0;font-size:12px}button{font:inherit;color:inherit;background:transparent;border:0;border-radius:4px;text-align:left;padding:8px 9px;width:100%;cursor:pointer}button:hover{background:#343c4a}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid #99b0ff}.row{display:flex;gap:4px}.row button{width:auto;flex:1;padding:6px}.timer{padding:8px;background:#2c3340;border-radius:5px;margin:6px 0}details{border-top:1px solid #424955;margin-top:8px;padding-top:6px}summary{padding:8px;cursor:pointer}.bottom{border-top:1px solid #424955;margin-top:8px;padding-top:5px}#error{color:#ffb3b3;margin:6px 8px}#error:empty{display:none}</style></head><body><main>
<header><strong>${esc(state.user?.shortName ?? S.desktopSignIn)}</strong><div class="muted">${esc(!available ? S.desktopNoConnection : focusOn(state) ? S.desktopFocusUntil(new Date(state.focusUntil ?? '').toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })) : S.desktopOnline)}</div></header>
${state.timer.task ? `<section class="timer"><strong>${esc(state.timer.task.mark ?? state.timer.task.title)}</strong><div id="timer" data-elapsed="${elapsed(state)}" data-running="${state.timer.state === 'run'}">${hoursMinutes(elapsed(state))}</div>${state.timer.startedAt ? `<div class="muted">${esc(S.desktopSince(new Date(state.timer.startedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })))}</div>` : ''}<div class="row">${button(state.timer.state === 'pause' ? 'resume' : 'pause', state.timer.state === 'pause' ? S.desktopResume : S.desktopPause, !available)}${button('change', S.desktopChange, !available)}${button('stop', S.desktopStop, !available)}</div></section>` : button('start', S.desktopStart, !available)}
${button('chat', S.desktopChat(state.chat), !available)}${button('notifications', S.desktopNotifications(state.notifications), !available)}
<details><summary>${esc(S.desktopFocus)}</summary>${focusOn(state) ? button('focus-off', S.desktopFocusOff, !available) : [button('focus-30', S.desktopFocus30, !available), button('focus-60', S.desktopFocus60, !available), button('focus-1500', S.desktopFocus1500, !available || new Date().getHours() >= 15), button('focus-end', S.desktopFocusEnd, !available)].join('')}</details>
${button('open', state.user ? S.menuOpen : S.desktopLogin)}<p id="error" role="status"></p><div class="bottom">${button('quit', S.menuQuit)}<div class="muted">${esc(S.menuVersion(version))}</div></div></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
