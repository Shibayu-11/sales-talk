import { app, BrowserWindow } from 'electron';
import { createControlWindow } from './windows/control';
import { createOverlayWindow } from './windows/overlay';
import { registerIpcHandlers } from './ipc';
import { logger } from './logger';
import { errorHandler } from './services/error-handler';

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
  errorHandler.handle({
    severity: 'high',
    category: 'unknown',
    code: 'unhandled_rejection',
    message: '予期しない非同期エラーが発生しました',
    technicalMessage: reason instanceof Error ? reason.message : String(reason),
    recoverable: true,
    recoveryAction: 'retry',
    context: { reason },
  });
});

process.on('uncaughtException', (error) => {
  errorHandler.handle({
    severity: 'critical',
    category: 'unknown',
    code: 'uncaught_exception',
    message: 'アプリの再起動が必要なエラーが発生しました',
    technicalMessage: error.message,
    recoverable: false,
    recoveryAction: 'restart',
    context: { error },
  });
});

export function getControlWindow(): BrowserWindow | null {
  return controlWindow;
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow;
}
