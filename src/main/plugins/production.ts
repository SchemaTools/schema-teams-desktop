import { join } from 'node:path';
import { app } from 'electron';
import { localDataPath } from '../localData';
import { PluginInstaller } from './installer';
import { readRevitProcesses } from './safety';
import {
  APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
  evaluatePublisherTrust,
  verifyPluginSignature,
} from './signature';

/** Ставить можно только при настроенном доверенном издателе (списки — в коде, не из env/IPC). */
export function pluginInstallationAvailable(): boolean {
  return process.platform === 'win32' && APPROVED_PLUGIN_PUBLISHER_DER_SHA256.length > 0;
}
/** Установщик с путями профиля Windows и проверкой подписи сертификатом бюро. */
export function createProductionInstaller(): PluginInstaller {
  const programData = process.env.ProgramData;
  return new PluginInstaller({
    root: localDataPath('plugins', process.env, app.getPath('userData')),
    addinsRoot: join(app.getPath('appData'), 'Autodesk', 'Revit', 'Addins'),
    machineAddinsRoot: programData ? join(programData, 'Autodesk', 'Revit', 'Addins') : null,
    trusted: async (path, sha256) =>
      evaluatePublisherTrust(
        await verifyPluginSignature(path, sha256),
        APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
      ),
    revit: readRevitProcesses,
  });
}
