import { contextBridge, ipcRenderer } from 'electron';
import type { PresenceView } from '../shared/client';
import type { ClientSnapshot, DesktopBridge } from '../shared/desktop';
const api: DesktopBridge = {
  request: (request) => ipcRenderer.invoke('client:request', request),
  subscribe(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: ClientSnapshot) => listener(state);
    ipcRenderer.on('client:state', receive);
    return () => ipcRenderer.removeListener('client:state', receive);
  },
  subscribePresence(listener) {
    const receive = (_event: Electron.IpcRendererEvent, presence: PresenceView) =>
      listener(presence);
    ipcRenderer.on('client:presence', receive);
    return () => ipcRenderer.removeListener('client:presence', receive);
  },
};
if (window.top === window) contextBridge.exposeInMainWorld('teams', api);
