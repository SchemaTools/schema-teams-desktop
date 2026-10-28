import type { Settings } from '../settings';
import { timerStrings as T } from './strings';

const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export function timerPreferencesPage(settings: Settings['timer']): string {
  const times = Array.from({ length: 48 }, (_, index) => {
    const value = `${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`;
    return `<option value="${value}"${value === settings.reminderTime ? ' selected' : ''}>${value}</option>`;
  }).join('');
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>${esc(T.preferencesTitle)}</title><style>
*{box-sizing:border-box}body{margin:0;color:#222938;background:#fff;font:14px/1.5 "Segoe UI",Arial,sans-serif;min-height:100vh;display:flex;flex-direction:column}main{padding:22px;flex:1}h1{font-size:20px;margin:0 0 18px}.check{display:flex;align-items:flex-start;gap:9px;margin:12px 0;color:#687184}.check input{margin:4px 0 0;flex:none}.notice{background:#fff6dd;border:1px solid #ebd498;border-radius:5px;padding:11px 12px;margin:15px 0 20px;font-size:13px}.field{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px}select{font:inherit;color:inherit;border:1px solid #b8c1ce;border-radius:5px;background:#fff;padding:7px 10px;min-width:100px}.muted{color:#687184;font-size:12px;margin:6px 0 0}.readonly{padding-top:16px;margin-top:20px;border-top:1px solid #e2e6ed}.readonly output{display:block;margin-top:4px;color:#687184}footer{padding:14px 22px;display:flex;gap:8px;justify-content:flex-end;background:#f4f5f8}button{font:inherit;padding:8px 14px;background:#fff;border:1px solid #cbd0da;border-radius:5px;cursor:pointer}#save{background:#203ed4;border-color:#203ed4;color:#fff}button:disabled{opacity:.6;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid #6d8aff;outline-offset:2px}#status{color:#a61d24;margin:10px 0 0;font-size:13px}#status:empty{display:none}</style></head><body><main><h1>${esc(T.preferencesHeading)}</h1>
<label class="check"><input type="checkbox" id="pause-on-lock" disabled${settings.pauseOnLock ? ' checked' : ''}>${esc(T.pauseOnLock)}</label>
<label class="check"><input type="checkbox" id="ask-on-unlock" disabled${settings.askOnUnlock ? ' checked' : ''}>${esc(T.askOnUnlock)}</label>
<p class="notice">${esc(T.serverUpdateRequired)}</p>
<div class="field"><label for="reminder-time">${esc(T.reminderTime)}</label><select id="reminder-time">${times}</select></div><p class="muted">${esc(T.reminderHint)}</p>
<div class="readonly"><span>${esc(T.workdayEnd)}</span><output id="workday-end">${esc(T.workdayUnknown)}</output></div>
<p id="status" role="status" data-failure="${esc(T.saveFailed)}"></p></main><footer><button id="close">${esc(T.cancel)}</button><button id="save">${esc(T.save)}</button></footer></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
