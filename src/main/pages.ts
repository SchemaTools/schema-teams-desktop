// Свои страницы-заглушки окна: «нет связи» до первой загрузки и «нет адреса сервера».
// Без скриптов; открываются как data:-адрес, тексты — из файла строк.
import { S } from './strings';

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function page(title: string, body: string, detail?: string): string {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${esc(S.appName)}</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;align-items:center;justify-content:center;background:#f2f4f5;color:#1a1d21;
font:14px/1.5 Inter,"Segoe UI",Arial,sans-serif}
.card{max-width:440px;padding:28px 32px;background:#fff;border:1px solid #c9ced2;border-radius:8px}
.mk{width:18px;height:18px;display:inline-block;vertical-align:-3px;margin-right:8px;
background:linear-gradient(135deg,#1a1d21 0 50%,#1b3fd1 50% 100%)}
h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#5f6469}.d{margin-top:12px;font:12px Consolas,monospace;color:#7d8388}
</style></head><body><div class="card"><h1><i class="mk"></i>${esc(title)}</h1><p>${esc(body)}</p>${
    detail ? `<p class="d">${esc(detail)}</p>` : ''
  }</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

export const offlinePage = (detail?: string) => page(S.offlineTitle, S.offlineBody, detail);
export const noServerPage = () => page(S.noServerTitle, S.noServerBody);
