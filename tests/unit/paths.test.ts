import { describe, expect, it } from 'vitest';
import { pathNeedsReveal, validateUncPath } from '../../src/main/paths/validate';

const root = String.raw`\\server\share`;
const separator = '\\';
const unc = (...components: string[]) =>
  root + (components.length ? separator + components.join(separator) : '');

describe('validateUncPath', () => {
  it('принимает корень общей папки и сохраняет регистр, Unicode и пробелы внутри имени', () => {
    for (const path of [
      root,
      unc('Объект А', 'АР', 'Модель 01.rvt'),
      unc('.hidden'),
      unc('План..rev.pdf'),
      unc('😀.png'),
    ])
      expect(validateUncPath(path)).toBe(path);
  });

  it('убирает ровно один завершающий разделитель папки', () => {
    expect(validateUncPath(root + separator)).toBe(root);
    expect(validateUncPath(unc('Папка') + separator)).toBe(unc('Папка'));
    expect(validateUncPath(root + separator.repeat(2))).toBeNull();
  });

  it('принимает только строковый UNC с непустыми server и share', () => {
    for (const path of [
      undefined,
      null,
      7,
      {},
      [],
      '',
      'relative.rvt',
      'C:\\file.rvt',
      'C:file.rvt',
      'file://server/share/file.rvt',
      '//server/share/file.rvt',
      separator + 'server',
      separator.repeat(2) + 'server',
      separator.repeat(2) + 'server' + separator,
      separator.repeat(3) + 'server' + separator + 'share',
    ])
      expect(validateUncPath(path)).toBeNull();
  });

  it('отвергает пространства устройств и NT, WebDAV-псевдохосты и не-файловые shares', () => {
    for (const path of [
      separator.repeat(2) + '?' + separator + 'UNC' + separator + 'server' + separator + 'share',
      separator.repeat(2) + '.' + separator + 'pipe' + separator + 'example',
      separator + '??' + separator + 'UNC' + separator + 'server' + separator + 'share',
      root.replace('server', 'server@SSL@443'),
      root.replace('server', 'server.'),
      root.replace('server', '-server'),
      root.replace('server', 'server..test'),
      root.replace('share', 'IPC$'),
      root.replace('share', 'pipe'),
      root.replace('share', 'mailslot'),
    ])
      expect(validateUncPath(path)).toBeNull();
  });

  it('не исправляет относительные/пустые компоненты, точки или пробелы', () => {
    for (const path of [
      unc('..', 'file.rvt'),
      unc('.', 'file.rvt'),
      unc('folder', '..', 'file.rvt'),
      unc('folder', '', 'file.rvt'),
      unc('file.exe.'),
      unc('file.exe '),
      unc(' folder', 'file.rvt'),
      unc('folder.', 'file.rvt'),
      unc('folder ', 'file.rvt'),
      unc('file.exe\u00a0'),
      ' ' + root,
      root + ' ',
    ])
      expect(validateUncPath(path)).toBeNull();
  });

  it('отвергает ADS, URL-кодирование, подстановки, слеши, управляющие и повреждённый Unicode', () => {
    for (const component of [
      'file.rvt:run.exe',
      'file.rvt::$DATA',
      '%2e%2e',
      '%252e%252e',
      '%5c%5c',
      '100%done.rvt',
      '%TEMP%',
      'folder/file.rvt',
      'file?.rvt',
      'file*.rvt',
      'file|more.rvt',
      'file<1>.rvt',
      'file".rvt',
      'file\u0000.exe',
      'file\r\n.exe',
      'file\u007f.exe',
      'file\u0085.exe',
      'file\u202eexe.rvt',
      'file\u200b.exe',
      'file\ud800.rvt',
    ])
      expect(validateUncPath(unc(component))).toBeNull();
  });

  it('блокирует зарезервированные DOS-устройства с расширением и нормализуемыми пробелами', () => {
    for (const component of [
      'CON',
      'nul.txt',
      'NUL.tar.gz',
      'AUX .exe',
      'COM1',
      'com9.txt',
      'LPT1.log',
      'LPT³.txt',
      'COM¹',
      'CONIN$',
      'CONOUT$.txt',
    ]) {
      expect(validateUncPath(unc(component))).toBeNull();
      expect(validateUncPath(unc(component, 'file.rvt'))).toBeNull();
    }
    expect(validateUncPath(unc('COM10.txt'))).toBe(unc('COM10.txt'));
    expect(validateUncPath(unc('console.rvt'))).toBe(unc('console.rvt'));
  });

  it('ограничивает компоненты и общий размер, не обрезая строку', () => {
    expect(validateUncPath(unc('x'.repeat(255)))).toBe(unc('x'.repeat(255)));
    expect(validateUncPath(unc('x'.repeat(256)))).toBeNull();
    const prefix = unc(...Array.from({ length: 127 }, () => 'x'.repeat(255)));
    const atLimit = prefix + separator + 'x'.repeat(32767 - prefix.length - 1);
    expect(atLimit.length).toBe(32767);
    expect(validateUncPath(atLimit)).toBe(atLimit);
    expect(validateUncPath(atLimit + 'x')).toBeNull();
  });
});

describe('pathNeedsReveal', () => {
  it.each([
    'exe',
    'msi',
    'bat',
    'cmd',
    'com',
    'scr',
    'ps1',
    'vbs',
    'vbe',
    'js',
    'jse',
    'wsf',
    'hta',
    'lnk',
    'reg',
    'cpl',
    'jar',
  ])('не запускает .%s независимо от регистра и предыдущих расширений', (extension) => {
    expect(pathNeedsReveal(unc(`Модель.rvt.${extension}`))).toBe(true);
    expect(pathNeedsReveal(unc(`file.${extension.toUpperCase()}`))).toBe(true);
    expect(pathNeedsReveal(unc(`.${extension}`))).toBe(true);
  });

  it('также защищает от ярлыков, пакетных установщиков и других запускателей', () => {
    for (const extension of [
      'url',
      'scf',
      'pif',
      'appref-ms',
      'application',
      'appx',
      'appxbundle',
      'msix',
      'msixbundle',
      'msu',
      'msp',
      'sct',
      'wsh',
      'psc1',
      'msc',
      'gadget',
      'psm1',
      'py',
      'pyw',
      'sh',
      'bash',
      'pl',
      'rb',
      'chm',
      'diagcab',
      'search-ms',
    ])
      expect(pathNeedsReveal(unc(`file.${extension}`))).toBe(true);
    expect(pathNeedsReveal(unc('file.jſ'))).toBe(true);
    expect(pathNeedsReveal(unc('README'))).toBe(true);
  });

  it('обычные документы открывает по последнему настоящему расширению', () => {
    for (const file of [
      'Модель.rvt',
      'АР.pdf',
      'Таблица.xlsx',
      'Снимок.PNG',
      'file.exe.txt',
      'Объект А.dwg',
    ])
      expect(pathNeedsReveal(unc(file))).toBe(false);
  });

  it('плохой путь не превращает в разрешение запуска', () => {
    for (const path of [
      unc('file.exe '),
      unc('file.exe.'),
      unc('file%2eexe'),
      unc('file.rvt:run.exe'),
      'file:///file.rvt',
    ])
      expect(pathNeedsReveal(path)).toBe(true);
  });
});
