// Значок приложения и установщика build/icon.ico — из того же знака, что и значок трея.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { drawMark, GRAPHITE } = require('../dist/main/mark.js');
const { encodeIco } = require('../dist/main/png.js');

const sizes = [16, 20, 24, 32, 40, 48, 64, 256];
mkdirSync(new URL('../build', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../build/icon.ico', import.meta.url),
  encodeIco(sizes.map((s) => drawMark(s, GRAPHITE))),
);
console.log('✓ build/icon.ico');
