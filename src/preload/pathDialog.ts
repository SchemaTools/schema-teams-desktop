import { ipcRenderer } from 'electron';
window.addEventListener('DOMContentLoaded', () => {
  const close = () => {
    void ipcRenderer.invoke('desktop:path-dialog', 'close').catch(() => {});
  };
  document.getElementById('close')?.addEventListener('click', close);
  document.getElementById('copy')?.addEventListener('click', async () => {
    const button = document.getElementById('copy');
    if (await ipcRenderer.invoke('desktop:path-dialog', 'copy').catch(() => false)) {
      if (button) button.textContent = button.dataset.copied ?? '';
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
});
