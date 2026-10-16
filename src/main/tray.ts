// Значок в трее (ТЗ, 4.1). На шаге Д1 — знак, подсказка, щелчок и короткое системное меню;
// счётчик, таймер, «Фокус» и своё меню-окно (Д-Т-2) — шаг Д3.
import { Menu, Tray, nativeTheme } from 'electron';
import { trayImage } from './icons';
import { S } from './strings';

export interface TrayOptions {
  version: string;
  onClick: () => void;
  onOpen: () => void;
  onQuit: () => void;
}

export function createTray(o: TrayOptions): Tray {
  const dark = () => nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  const tray = new Tray(trayImage(dark()));
  tray.setToolTip(S.trayTooltip);
  tray.on('click', o.onClick);
  const menu = Menu.buildFromTemplate([
    { label: S.menuOpen, click: o.onOpen },
    { type: 'separator' },
    { label: S.menuVersion(o.version), enabled: false },
    { label: S.menuQuit, click: o.onQuit },
  ]);
  tray.on('right-click', () => tray.popUpContextMenu(menu));
  // панель задач сменила тему — перерисовать знак
  nativeTheme.on('updated', () => tray.setImage(trayImage(dark())));
  return tray;
}
