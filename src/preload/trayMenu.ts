import { ipcRenderer } from 'electron';
window.addEventListener('DOMContentLoaded', () => {
  let busy = false;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    button.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      try {
        const result: unknown = await ipcRenderer.invoke('desktop:menu', button.dataset.action);
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          typeof result.error === 'string'
        ) {
          const status = document.getElementById('error');
          if (status) status.textContent = result.error;
        }
      } finally {
        busy = false;
      }
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') void ipcRenderer.invoke('desktop:menu', 'hide');
  });
  const clock = document.getElementById('timer');
  if (clock?.dataset.running === 'true') {
    const base = Number(clock.dataset.elapsed);
    const since = Date.now();
    setInterval(() => {
      const seconds = base + Math.floor((Date.now() - since) / 1000);
      clock.textContent = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`;
    }, 1000);
  }
});
