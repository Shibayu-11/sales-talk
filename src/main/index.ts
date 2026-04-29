import { app, BrowserWindow } from 'electron';
import { createControlWindow } from './windows/control';
import { createOverlayWindow } from './windows/overlay';
import { registerIpcHandlers } from './ipc';
import { logger } from './logger';

const isDev = !app.isPackaged;

let controlWindow: BrowserWindow | null = null;
let overlayWindow: BrowserWindow | null = null;

async function createWindows(): Promise<void> {
  controlWindow = createControlWindow();
  overlayWindow = createOverlayWindow();
}

app.whenReady().then(async () => {
  logger.info({ isDev, version: app.getVersion() }, 'app ready');
  registerIpcHandlers({ getControlWindow, getOverlayWindow });
  await createWindows();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindows();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
});

export function getControlWindow(): BrowserWindow | null {
  return controlWindow;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}
