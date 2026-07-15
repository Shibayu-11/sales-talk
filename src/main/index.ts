import './app-identity';
import { app, BrowserWindow } from 'electron';
import { createControlWindow } from './windows/control';
import { createOverlayWindow } from './windows/overlay';
import { registerIpcHandlers } from './ipc';
import { logger } from './logger';
import { errorHandler } from './services/error-handler';

const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// CLI mode detection — checked before any GUI work.
// If --cli is present in argv, route to headless CLI and exit.
// ---------------------------------------------------------------------------
const isCliMode = process.argv.includes('--cli');

if (isCliMode) {
  // Single-instance lock: if a GUI instance is already running, second-instance
  // handling below will forward the argv to it. For CLI transcribe/minutes this
  // is fine (they don't share native capture state). For record start/stop with a
  // live GUI session, the user should use the GUI instead; the CLI will report
  // an error if capture is already active.
  //
  // REQUIRES on-device verification: app.requestSingleInstanceLock() returns false
  // when a GUI instance owns the lock. We proceed headlessly regardless, because
  // transcribe/minutes operate on stored data and don't need the GUI instance.
  app.whenReady().then(async () => {
    const { runCli } = await import('./cli/index');
    await runCli(process.argv);
  }).catch((err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ ok: false, error: 'cli_init_failed', detail }) + '\n');
    app.exit(1);
  });
} else {
  // ---------------------------------------------------------------------------
  // Normal GUI mode
  // ---------------------------------------------------------------------------

  // Register URL scheme handler for macOS Shortcuts / Spotlight.
  // REQUIRES on-device verification: setAsDefaultProtocolClient works only in
  // a packaged/signed build; in dev mode use `open salestalk://` after setting
  // the plist via electron-builder.
  app.setAsDefaultProtocolClient('salestalk');

  const getControlWindowInner = (): BrowserWindow | null => _controlWindow;
  const getOverlayWindowInner = (): BrowserWindow | null => _overlayWindow;

  const createWindows = async (): Promise<void> => {
    _controlWindow = createControlWindow();
    _overlayWindow = createOverlayWindow();
  };

  /** Handle `salestalk://record/start?product=real_estate` and `salestalk://record/stop` */
  const handleProtocolUrl = (urlStr: string): void => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      logger.warn({ urlStr }, 'protocol handler received invalid URL');
      return;
    }

    // pathname is e.g. "//record/start" — strip leading slashes
    const path = url.pathname.replace(/^\/+/, '');
    const [domain, action] = path.split('/');

    if (domain !== 'record') {
      logger.warn({ path }, 'unsupported salestalk:// path');
      return;
    }

    if (action === 'start') {
      const product = url.searchParams.get('product') ?? undefined;
      // Drives the GUI instance's singleton session (shared with the start button).
      void handleProtocolRecordStart(product);
    } else if (action === 'stop') {
      void handleProtocolRecordStop();
    } else {
      logger.warn({ action }, 'unsupported salestalk://record action');
    }
  };

  const protocolWindows = {
    getControlWindow: getControlWindowInner,
    getOverlayWindow: getOverlayWindowInner,
  };

  // Shortcut/Spotlight-triggered recording. The consent is still obtained
  // verbally in the live call; the notice version flags the protocol entry point
  // so the audit trail distinguishes it from the GUI button.
  const protocolConsent = () => ({
    status: 'granted' as const,
    method: 'verbal' as const,
    capturedAt: new Date().toISOString(),
    noticeVersion: 'shortcut-v1',
  });

  const handleProtocolRecordStart = async (product?: string): Promise<void> => {
    const { startRecordingSession } = await import('./ipc');
    const { ProductIdSchema } = await import('@shared/schemas');
    const parsed = ProductIdSchema.safeParse(product ?? 'real_estate');
    if (!parsed.success) {
      logger.warn({ product }, 'protocol record start: invalid product');
      return;
    }
    // Routes through the singleton session so STT, overlay, and the objection
    // pipeline all run — same path as the GUI start button.
    const result = await startRecordingSession(protocolWindows, {
      productId: parsed.data,
      consent: protocolConsent(),
      source: 'zoom_desktop',
    });
    logger.info({ result }, 'protocol record start');
  };

  const handleProtocolRecordStop = async (): Promise<void> => {
    const { stopRecordingSession } = await import('./ipc');
    const result = await stopRecordingSession(protocolWindows);
    logger.info({ result }, 'protocol record stop');
  };

  /**
   * Auto-update is packaged-build only (electron-updater is a no-op unpackaged).
   * Per PRD §32 the UpdateManager defers installs while a call is active.
   */
  const startAutoUpdater = async (): Promise<void> => {
    if (isDev) {
      logger.info('auto-updater disabled in dev');
      return;
    }
    try {
      const { createElectronUpdaterDriver } = await import('./services/updater-driver');
      const { UpdateManager } = await import('./services/updater');
      const { isRecordingInProgress, onCallEnded } = await import('./ipc');

      const driver = await createElectronUpdaterDriver((message, context) =>
        logger.info({ ...context }, message),
      );
      const manager = new UpdateManager({
        driver,
        isInCall: isRecordingInProgress,
        log: (message, context) => logger.info({ ...context }, message),
      });
      onCallEnded(() => manager.onCallEnded());
      manager.start();
      logger.info('auto-updater started');
    } catch (error) {
      logger.warn({ error }, 'auto-updater failed to start');
    }
  };

  // macOS: URL scheme arrives as `open-url` event
  app.on('open-url', (_event, urlStr) => {
    handleProtocolUrl(urlStr);
  });

  // Windows / second-instance fallback: URL scheme may arrive in argv
  app.on('second-instance', (_event, argv) => {
    const protocolArg = argv.find((a) => a.startsWith('salestalk://'));
    if (protocolArg) {
      handleProtocolUrl(protocolArg);
    }
    // Bring existing window to front
    if (_controlWindow) {
      if (_controlWindow.isMinimized()) _controlWindow.restore();
      _controlWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logger.info({ isDev, version: app.getVersion() }, 'app ready');
    registerIpcHandlers({ getControlWindow: getControlWindowInner, getOverlayWindow: getOverlayWindowInner });
    await createWindows();
    await startAutoUpdater();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindows();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

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

// Module-level window accessors — only valid in GUI mode.
// In CLI mode these always return null (no windows are created).
let _controlWindow: BrowserWindow | null = null;
let _overlayWindow: BrowserWindow | null = null;

export function getControlWindow(): BrowserWindow | null {
  return _controlWindow;
}

export function getOverlayWindow(): BrowserWindow | null {
  return _overlayWindow;
}
