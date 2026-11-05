// Своё всплывающее уведомление (Д2, решение по Windows 10) — вид по макету v4 «Мессенджер»:
// карточка со скруглением 14, отправитель с буквами-обложкой, поле ответа-«таблетка» и круглая
// «Отправить», кнопки-«таблетки». Тёмная тема передаётся явно: в этом окне prefers-color-scheme
// не следует nativeTheme.themeSource (проверено 05.11). Данные — только текст, скриптов страницы нет; ввод — изолированный preload.
import { S } from '../strings';
import { REPLY_LIMIT, type ToastSpec } from './types';
import { closeGlyph, sendGlyph } from './glyphs';

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c;
  });
}

/** Буквы обложки, как у аватара в окне: «Петров П.П.» → «ПП». */
export function toastInitials(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .split(/[\s.]+/)
    .filter(Boolean);
  const letters = (words.length > 1 ? [words[0], words[1]] : [words[0] ?? '']).map(
    (w) => [...(w ?? '')][0] ?? '',
  );
  return letters.join('').toUpperCase() || '·';
}

/** Цвет обложки — из того же набора групп, что в окне, по названию. */
const COVERS = ['#2e7d32', '#1b3fd1', '#b23a48', '#8e44ad', '#c75b12', '#00838f'];
function coverColor(title: string): string {
  let h = 0;
  for (const ch of title) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return COVERS[h % COVERS.length] ?? COVERS[0] ?? '#1b3fd1';
}

export function customToastPage(spec: ToastSpec, dark = false): string {
  const html = `<!doctype html><html lang="ru"${dark ? ' class="dark"' : ''}><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
<meta name="color-scheme" content="${dark ? 'dark' : 'light'}">
<title>${esc(S.customToastTitle)}</title>
<style>
:root{--side:#fff;--ink:#000;--body:#222;--meta:#707579;--rule:#e9e9ea;--hover:#f4f4f5;
--acc:#1b3fd1;--acc-h:#1532a8;--acc-t:#1b3fd1;--acc-soft:#e8ecfb;--ok:#168058;--bad:#a32020;--control-line:#626e79}
:root.dark{--side:#17212b;--ink:#f5f5f5;--body:#e9ecef;
--meta:#8b9aa8;--rule:#0e1621;--hover:#202b36;--acc:#2f55ff;--acc-h:#4467ff;--acc-t:#9db0ff;
--acc-soft:#1c2a4a;--ok:#6fd19a;--bad:#ff9a9a;--control-line:#718397}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:transparent;color:var(--body);font:14px/1.4 Inter,"Segoe UI",Arial,sans-serif}
.toast{height:100%;padding:14px;border:1px solid var(--rule);border-radius:14px;background:var(--side);
display:flex;flex-direction:column;gap:10px;overflow:auto;scrollbar-width:thin}
.app{display:flex;align-items:center;gap:7px;color:var(--meta);font-size:12px}
.mark{width:12px;height:12px;border-radius:3px;background:linear-gradient(135deg,var(--ink) 0 50%,var(--acc) 50% 100%)}
.h{display:flex;align-items:center;gap:10px;cursor:pointer;border-radius:10px}
.av{width:40px;height:40px;flex:none;border-radius:50%;display:grid;place-items:center;color:#fff;
font-weight:600;font-size:14px}
.h .tx{min-width:0;flex:1}
h1{display:block;margin:0;font-size:15px;font-weight:600;color:var(--ink);overflow-wrap:anywhere}
.body{margin:1px 0 0;font-size:13px;color:var(--body);white-space:pre-wrap;overflow-wrap:anywhere;
max-height:54px;overflow:auto}
button{font:inherit;cursor:pointer;border:0;color:inherit;background:transparent}
button:focus-visible,textarea:focus-visible,.h:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
#close{margin-left:auto;width:24px;height:24px;border-radius:12px;display:grid;place-items:center;color:var(--meta)}
#close:hover{background:var(--hover)}
.reply-row{display:flex;gap:8px;align-items:flex-end}
textarea{resize:none;min-width:0;flex:1;height:40px;max-height:72px;padding:9px 13px;border:1px solid var(--control-line);
border-radius:20px;background:var(--hover);color:var(--ink);font:inherit;font-size:14px;line-height:20px}
textarea::placeholder{color:var(--meta)}
#send{width:40px;height:40px;flex:none;border-radius:50%;background:var(--acc);color:#fff;
display:grid;place-items:center}
#send:hover{background:var(--acc-h)}button:disabled{opacity:.55;cursor:default}
.hint{font-size:11px;color:var(--meta);margin:4px 0 0 14px}
.actions{display:flex;gap:6px;margin-top:auto}
.actions button{flex:1;height:32px;border-radius:16px;background:var(--acc-soft);color:var(--acc-t);
font-weight:600;font-size:13px}.actions button:hover{filter:brightness(.97)}
#status{color:var(--ok);margin:0;font-size:13px}#status:empty{display:none}
#status[data-state="error"]{color:var(--bad)}
</style></head><body><section class="toast" aria-label="${esc(S.customToastTitle)}">
<div class="app"><span class="mark" aria-hidden="true"></span>${esc(spec.header ? `${S.appName} · ${spec.header}` : S.appName)}
<button id="close" aria-label="${esc(S.customToastClose)}">${closeGlyph}</button></div>
<div id="message" class="h" role="button" tabindex="0" aria-label="${esc(S.menuOpen)}"><span class="av" style="background:${coverColor(spec.title)}" aria-hidden="true">${esc(toastInitials(spec.title))}</span><span class="tx"><h1>${esc(spec.title)}</h1><p class="body">${esc(spec.body)}</p></span></div>
${
  spec.hasReply
    ? `<div id="reply-box"><div class="reply-row"><textarea id="reply" rows="1" maxlength="${REPLY_LIMIT}" aria-label="${esc(S.customToastReply)}" placeholder="${esc(S.customToastReply)}"></textarea><button id="send" aria-label="${esc(S.customToastSend)}" title="${esc(S.customToastSend)}">${sendGlyph}</button></div><div class="hint">${esc(S.customToastKeys)}</div></div>`
    : ''
}
<p id="status" role="status" aria-live="polite"></p>
<div class="actions">${spec.buttons.map((label, index) => `<button data-action="${index}">${esc(label)}</button>`).join('')}</div>
</section></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
