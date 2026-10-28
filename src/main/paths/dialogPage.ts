import { S } from '../strings';
const esc = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
export function pathDialogPage(path: string): string {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';base-uri 'none';form-action 'none'"><title>${S.pathUnavailableTitle}</title><style>
*{box-sizing:border-box}body{margin:0;color:#222938;background:#fff;font:14px/1.45 "Segoe UI",Arial,sans-serif;min-height:100vh;display:flex;flex-direction:column}main{padding:22px;flex:1}h1{font-size:18px;margin:0 0 10px}#path{font:12px/1.45 Consolas,monospace;word-break:break-all;max-height:92px;overflow:auto;background:#f4f5f8;padding:10px;border-radius:4px}footer{padding:14px 20px;display:flex;gap:8px;justify-content:flex-end;background:#f4f5f8}button{font:inherit;padding:8px 12px;background:white;border:1px solid #cbd0da;border-radius:5px;cursor:pointer}#close{background:#203ed4;border-color:#203ed4;color:#fff}button:focus-visible{outline:2px solid #6d8aff;outline-offset:2px}</style></head><body><main><h1>${S.pathUnavailableTitle}</h1><div id="path">${esc(path)}</div><p>${S.pathUnavailableBody}</p></main><footer><button id="copy" data-copied="${S.pathCopied}">${S.pathCopy}</button><button id="close">${S.pathUnderstood}</button></footer></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
