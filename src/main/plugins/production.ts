import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { PLUGIN_SET_CODE } from '../../shared/plugins';
import { readBuildConfig } from '../config';
import { localDataPath } from '../localData';
import { ensureBureauSettings } from './bureauSettings';
import { certificateDer, ensureBureauCertificate } from './certificate';
import { PluginInstaller } from './installer';
import { replaceInnoInstall } from './legacyInno';
import { readRevitProcesses } from './safety';
import { readCertStores, readInnoUninstall } from './setupNative';
import {
  APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
  evaluatePublisherTrust,
  verifyPluginSignature,
} from './signature';
import type { PluginTrustOutcome, PluginUpdaterPorts } from './updater';

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

/** Запуск без shell: код выхода (ошибка запуска — исключение). */
function run(file: string, args: readonly string[], timeout: number): Promise<number> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { shell: false, windowsHide: true, timeout, maxBuffer: 1024 * 1024 },
      (error) => {
        if (!error) return resolve(0);
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') resolve(code);
        else reject(error);
      },
    );
  });
}
const system32 = () => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

/**
 * Подготовка компьютера к набору плагинов (решение руководителя 06.11): сертификат бюро в
 * хранилищах пользователя, замена прежней установки Inno, bureau.txt. Только на Windows.
 */
export function createPluginSetup(): Pick<PluginUpdaterPorts, 'ensureTrust' | 'beforeCommit'> {
  if (process.platform !== 'win32') return {};
  let trusted = false;
  const buildConfig = () => readBuildConfig(join(app.getAppPath(), 'dist', 'build-config.json'));
  const bureauFile = join(app.getPath('appData'), 'Schema', 'bureau.txt');
  return {
    ensureTrust: async (o): Promise<PluginTrustOutcome> => {
      if (trusted) return 'ok';
      const outcome = await ensureBureauCertificate(
        {
          certificate: async () => {
            try {
              return certificateDer(
                await readFile(join(app.getAppPath(), 'dist', 'plugin-cert.cer')),
              );
            } catch {
              return null;
            }
          },
          pins: APPROVED_PLUGIN_PUBLISHER_DER_SHA256,
          stores: readCertStores,
          addStore: async (store, der) => {
            // certutil читает файл с диска (не из asar): своя временная папка, затем удаляется.
            const dir = await mkdtemp(join(tmpdir(), 'schema-cert-'));
            try {
              const file = join(dir, 'schema-bureau.cer');
              await writeFile(file, der, { mode: 0o600 });
              return await run(
                join(system32(), 'certutil.exe'),
                ['-user', '-addstore', store, file],
                10 * 60 * 1000,
              );
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          },
        },
        o,
      );
      if (outcome === 'ok') trusted = true;
      return outcome;
    },
    beforeCommit: async (code, first) => {
      if (code !== PLUGIN_SET_CODE) return null;
      let warning: string | null = null;
      if (first) {
        const local = process.env.LOCALAPPDATA;
        const result = local
          ? await replaceInnoInstall({
              localAppData: local,
              bureauFile,
              readUninstall: readInnoUninstall,
              run: (exe, args) => run(exe, args, 10 * 60 * 1000),
            })
          : ({ outcome: 'failed', reason: 'legacy_failed' } as const);
        if (result.outcome === 'failed') warning = result.reason;
      }
      try {
        await ensureBureauSettings(bureauFile, buildConfig().bureau ?? {});
      } catch {
        warning ??= 'bureau_settings_failed';
      }
      return warning;
    },
  };
}
