import { ipcRenderer } from 'electron';

window.addEventListener('DOMContentLoaded', () => {
  let busy = false;
  const close = () => {
    if (!busy)
      void ipcRenderer.invoke('desktop:timer-preferences', { action: 'close' }).catch(() => {});
  };
  document.getElementById('close')?.addEventListener('click', close);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  const select = document.getElementById('reminder-time');
  if (select instanceof HTMLSelectElement) select.focus();
  document.getElementById('save')?.addEventListener('click', async () => {
    if (busy || !(select instanceof HTMLSelectElement)) return;
    busy = true;
    const save = document.getElementById('save');
    if (save instanceof HTMLButtonElement) save.disabled = true;
    const status = document.getElementById('status');
    if (status) status.textContent = '';
    try {
      const result: unknown = await ipcRenderer.invoke('desktop:timer-preferences', {
        action: 'save',
        reminderTime: select.value,
      });
      if (
        result &&
        typeof result === 'object' &&
        'ok' in result &&
        result.ok === false &&
        'error' in result &&
        typeof result.error === 'string'
      ) {
        if (status) status.textContent = result.error;
      }
    } catch {
      if (status) status.textContent = status.dataset.failure ?? '';
    } finally {
      busy = false;
      if (save instanceof HTMLButtonElement) save.disabled = false;
    }
  });
});
