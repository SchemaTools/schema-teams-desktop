// Локальная страница опыта Д2: оформление Д-У-0 из согласованного макета.
// Данные — только текст, скриптов страницы нет; ввод обрабатывает изолированный preload.
import { S } from '../strings';
import type { ToastSpec } from './toastScenarios';

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c;
  });
}

export function customToastPage(spec: ToastSpec): string {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<title>${esc(S.customToastTitle)}</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:1px;background:transparent;color:#1a1d21;
font:13px/1.4 "Segoe UI",Arial,sans-serif}
.toast{height:calc(100vh - 2px);padding:12px;border:1px solid #c9ced2;border-radius:8px;
background:#f9f9f9;display:flex;flex-direction:column;gap:9px;overflow:auto;scrollbar-width:thin}
header{display:flex;align-items:center;gap:6px;color:#5f6469;font-size:11px}
.mark{width:12px;height:12px;background:linear-gradient(135deg,#1a1d21 0 50%,#1b3fd1 50% 100%)}
button{font:inherit;cursor:pointer;border:1px solid #c9ced2;border-radius:6px;background:#fff;
padding:6px 10px;color:#1a1d21}button:hover{background:#edf0f8}button:focus-visible,
textarea:focus-visible{outline:2px solid #1b3fd1;outline-offset:1px}
#close{margin-left:auto;border:0;padding:0 4px;font-size:18px;line-height:18px;background:transparent}
h1{font-size:13px;margin:0;font-weight:600;overflow-wrap:anywhere}#message{cursor:pointer}
.body{margin:2px 0 0;color:#333;white-space:pre-wrap;overflow-wrap:anywhere;max-height:56px;overflow:auto}
.reply-row{display:flex;gap:6px}textarea{resize:none;min-width:0;flex:1;height:60px;
border:1px solid #c9ced2;border-radius:6px;padding:7px 8px;font:inherit;background:#fff;color:#1a1d21}
#send{align-self:stretch;background:#1b3fd1;color:#fff;border-color:#1b3fd1;font-size:18px;padding:5px 11px}
#send:hover{background:#1433ad}button:disabled{opacity:.55;cursor:default}
.hint{font-size:11px;color:#5f6469;margin-top:4px}.actions{display:flex;gap:6px;margin-top:auto}
.actions button{flex:1}#status{color:#168058;margin:0;min-height:0}#status:empty{display:none}
</style></head><body><section class="toast" aria-label="${esc(S.customToastTitle)}">
<header><span class="mark" aria-hidden="true"></span>${esc(S.appName)}
<button id="close" aria-label="${esc(S.customToastClose)}">×</button></header>
<div id="message" role="button" tabindex="0" aria-label="${esc(S.menuOpen)}"><h1>${esc(spec.title)}</h1><p class="body">${esc(spec.body)}</p></div>
${
  spec.hasReply
    ? `<div id="reply-box"><div class="reply-row"><textarea id="reply" rows="2" maxlength="32000" aria-label="${esc(S.customToastReply)}" placeholder="${esc(S.customToastReply)}"></textarea><button id="send" aria-label="${esc(S.customToastSend)}" title="${esc(S.customToastSend)}">➤</button></div><div class="hint">${esc(S.customToastKeys)}</div></div>`
    : ''
}
<p id="status" role="status" aria-live="polite"></p>
<div class="actions">${spec.buttons.map((label, index) => `<button data-action="${index}">${esc(label)}</button>`).join('')}</div>
</section></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
