import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — скрипт сборки на JavaScript без объявлений типов
import * as licenses from '../../scripts/check-licenses.mjs';

type Lock = { packages: Record<string, Record<string, unknown>> };
type Check = {
  isLicenseAllowed: (license: unknown) => boolean;
  productPackages: (lock: Lock, bundled?: string[]) => string[];
  findViolations: (
    lock: Lock,
    read?: (location: string) => unknown,
  ) => { name: string; version: string; license: string }[];
  RENDERER_BUNDLED: string[];
};
const { isLicenseAllowed, productPackages, findViolations, RENDERER_BUNDLED } = licenses as Check;

describe('isLicenseAllowed', () => {
  it.each(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD'])(
    'разрешает %s',
    (l) => {
      expect(isLicenseAllowed(l)).toBe(true);
    },
  );
  it.each(['GPL-3.0', 'LGPL-2.1', 'MPL-2.0', 'WTFPL', 'UNLICENSED', '', undefined])(
    'запрещает %s',
    (l) => {
      expect(isLicenseAllowed(l)).toBe(false);
    },
  );
  it('«или» — достаточно одной разрешённой, «и» — нужны все', () => {
    expect(isLicenseAllowed('(MIT OR GPL-3.0)')).toBe(true);
    expect(isLicenseAllowed('MIT AND GPL-3.0')).toBe(false);
  });
});

describe('findViolations', () => {
  const lock: Lock = {
    packages: {
      '': {
        dependencies: { client: '*' },
        devDependencies: { ui: '*', tool: '*', '@fontsource/font': '*' },
      },
      'node_modules/client': {
        version: '1.0.0',
        license: 'MIT',
        dependencies: { old: '*', bad: '*' },
      },
      'node_modules/old': { version: '2.1.2' },
      'node_modules/bad': { version: '1.0.0', license: 'GPL-3.0' },
      'node_modules/ui': {
        version: '1.0.0',
        license: 'MIT',
        dev: true,
        dependencies: { helper: '*' },
      },
      'node_modules/helper': { version: '1.0.0', license: 'LGPL-3.0', dev: true },
      'node_modules/tool': { version: '1.0.0', license: 'MPL-2.0', dev: true },
      'node_modules/@fontsource/font': { version: '5.3.0', license: 'OFL-1.1', dev: true },
    },
  };
  const read = (location: string) =>
    location === 'node_modules/old' ? { licenses: [{ type: 'MIT', url: 'http://x' }] } : undefined;

  it('поставка — dependencies и пакеты интерфейса со своими зависимостями; инструменты не входят', () => {
    expect(productPackages(lock, ['ui', '@fontsource/font'])).toEqual([
      'node_modules/@fontsource/font',
      'node_modules/bad',
      'node_modules/client',
      'node_modules/helper',
      'node_modules/old',
      'node_modules/ui',
    ]);
  });

  it('находит запрещённые; старое поле licenses понимает; OFL у шрифта разрешена', () => {
    const names = findViolations(lock, read).map((v) => v.name);
    expect(names).toContain('node_modules/bad');
    expect(names).not.toContain('node_modules/old');
    expect(names).not.toContain('node_modules/tool');
    expect(names).not.toContain('node_modules/@fontsource/font');
  });
});

describe('RENDERER_BUNDLED', () => {
  it('совпадает со списком лицензий, которые копирует build-renderer.mjs', () => {
    const build = readFileSync(resolve(__dirname, '../../scripts/build-renderer.mjs'), 'utf8');
    const copied = [...build.matchAll(/\['([^']+)', 'LICENSE'\]/g)].map((m) => m[1]);
    expect([...RENDERER_BUNDLED].sort()).toEqual(copied.sort());
  });
});
