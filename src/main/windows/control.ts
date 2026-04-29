import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';

/**
 * Control window: settings, history, knowledge, product selector. Per PRD §3.4.
 * Standard window — no transparency tricks.
 */
export function createControlWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0F0F12',
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'out/preload/control.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Avoid being captured during screen sharing as well — per PRD §20.7
  // (control window holds knowledge / customer info that must never leak).
  win.setContentProtection(true);

  win.once('ready-to-show', () => win.show());

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/control/index.html`);
  } else {
    void win.loadFile(join(app.getAppPath(), 'out/renderer/control/index.html'));
  }

  return win;
}
