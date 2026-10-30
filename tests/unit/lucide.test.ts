import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { closeGlyph, sendGlyph } from '../../src/main/notifications/glyphs';
const require = createRequire(resolve('package.json'));
describe('Lucide distribution and native popup source parity', () => {
  it('pins React-compatible 1.54.0 and distributes the full ISC + Feather MIT license', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.devDependencies['lucide-react']).toBe('1.54.0');
    expect(pkg.devDependencies.react).toBe('18.3.1');
    expect(pkg.devDependencies['@phosphor-icons/react']).toBeUndefined();
    const license = readFileSync('node_modules/lucide-react/LICENSE', 'utf8');
    expect(license).toContain('ISC License');
    expect(license).toContain('The MIT License (MIT)');
    expect(license).toContain('Cole Bemis');
    expect(readFileSync('scripts/build-renderer.mjs', 'utf8')).toContain(
      "['lucide-react', 'LICENSE']",
    );
  });
  it('native markup uses exact installed X/Send paths and trusted stroke SVG only', () => {
    const root = require.resolve('lucide-react/package.json').replace(/package\.json$/, '');
    for (const [name, markup] of [
      ['x', closeGlyph],
      ['send', sendGlyph],
    ] as const) {
      const source = readFileSync(`${root}dist/esm/icons/${name}.mjs`, 'utf8');
      for (const match of markup.matchAll(/\sd="([^"]+)"/g))
        expect(source).toContain(`"${match[1]}"`);
      expect(markup).toContain('fill="none"');
      expect(markup).toContain('stroke-width="2"');
      expect(markup).not.toMatch(/script|href|onload|style=/);
    }
  });
});
