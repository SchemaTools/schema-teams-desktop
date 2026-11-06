// Значок приложения и установщика build/icon.ico — плитка электрик с белым знаком (mark.ts),
// тот же, что у окна приложения (icons.ts, windowImage).
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { appIconBitmaps } = require('../dist/main/mark.js');
const { encodeIco } = require('../dist/main/png.js');

mkdirSync(new URL('../build', import.meta.url), { recursive: true });
writeFileSync(new URL('../build/icon.ico', import.meta.url), encodeIco(appIconBitmaps()));
console.log('✓ build/icon.ico');
