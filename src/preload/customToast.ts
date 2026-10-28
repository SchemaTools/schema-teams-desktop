// Только локальное окно опыта Д2. API Electron в основной мир страницы не выдаётся.
import { ipcRenderer } from 'electron';

const CHANNEL = 'desktop:toast';
const RESULT = 'desktop:toast-result';

window.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('reply') as HTMLTextAreaElement | null;
  const send = document.getElementById('send') as HTMLButtonElement | null;
  let pending = false;
  const submit = () => {
    if (!input || pending || input.value.trim() === '') return;
    pending = true;
    input.disabled = true;
    if (send) send.disabled = true;
    ipcRenderer.send(CHANNEL, { action: 'reply', text: input.value });
  };
  input?.addEventListener('keydown', (event) => {
    // Enter завершения IME-композиции не должен отправлять незаконченный текст.
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  });
  send?.addEventListener('click', submit);
  const open = () => {
    if (pending) return;
    pending = true;
    ipcRenderer.send(CHANNEL, { action: 'open' });
  };
  document.body.addEventListener('click', (event) => {
    if (
      event.target instanceof Element &&
      !event.target.closest('button, textarea, .hint, #status')
    ) {
      open();
    }
  });
  document.getElementById('message')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  });
  document.getElementById('close')?.addEventListener('click', () => {
    ipcRenderer.send(CHANNEL, { action: 'close' });
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.addEventListener('click', () => {
      if (pending) return;
      pending = true;
      ipcRenderer.send(CHANNEL, { action: 'button', index: Number(button.dataset.action) });
    });
  }
  const draft = () => {
    ipcRenderer.send(CHANNEL, {
      action: 'draft',
      active: document.activeElement === input || Boolean(input?.value),
    });
  };
  input?.addEventListener('input', draft);
  input?.addEventListener('focus', draft);
  input?.addEventListener('blur', draft);
  document.body.addEventListener('mouseenter', () => {
    ipcRenderer.send(CHANNEL, { action: 'hover', active: true });
  });
  document.body.addEventListener('mouseleave', () => {
    ipcRenderer.send(CHANNEL, { action: 'hover', active: false });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') ipcRenderer.send(CHANNEL, { action: 'close' });
  });
  ipcRenderer.on(RESULT, (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) return;
    const result = raw as Record<string, unknown>;
    if (typeof result.ok !== 'boolean' || typeof result.message !== 'string') return;
    const status = document.getElementById('status');
    if (status) {
      status.textContent = result.message;
      status.dataset.state = result.ok ? 'success' : 'error';
    }
    const replyBox = document.getElementById('reply-box');
    if (replyBox) replyBox.hidden = result.ok;
    if (!result.ok) {
      pending = false;
      if (input) input.disabled = false;
      if (send) send.disabled = false;
      draft();
    }
  });
});
