import type { UpdaterDriver } from './updater';

/**
 * Real electron-updater adapter. Isolated from UpdateManager so the install-policy
 * (PRD §32: never during a call) stays unit-testable without electron-updater.
 *
 * electron-updater is imported lazily because it has no effect in dev (unpackaged)
 * builds and we don't want it loaded during tests.
 */
export async function createElectronUpdaterDriver(
  log: (message: string, context?: Record<string, unknown>) => void,
): Promise<UpdaterDriver> {
  const updaterModule = await import('electron-updater');
  const autoUpdater = updaterModule.autoUpdater;

  // We control install timing ourselves (defer during calls), so disable the
  // library's own auto-install-on-quit behavior.
  autoUpdater.autoInstallOnAppQuit = false;

  return {
    checkForUpdates: () => {
      autoUpdater.checkForUpdates().catch((error: unknown) => {
        log('checkForUpdates failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    quitAndInstall: () => {
      // isSilent=false, isForceRunAfter=true so the app relaunches post-install.
      autoUpdater.quitAndInstall(false, true);
    },
    onUpdateDownloaded: (handler) => {
      autoUpdater.on('update-downloaded', handler);
    },
    onError: (handler) => {
      autoUpdater.on('error', handler);
    },
  };
}
