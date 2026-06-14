import { UPDATE_DEFERRED_RETRY_MS } from '@shared/constants';

/**
 * Auto-update manager. Per PRD §32 / CLAUDE.md §7:
 * 商談中は絶対に更新しない。更新がダウンロード済みでも、通話が終わるまで install を遅延し、
 * 15分ごとに再確認する。検知・ダウンロードは通話中でも進めてよい(install のみ遅延)。
 *
 * The electron-updater coupling is injected so the policy is unit-testable without
 * a real update server or app restart.
 */

export interface UpdaterDriver {
  /** Begin checking for updates (download happens automatically on availability). */
  checkForUpdates(): void;
  /** Quit and install the downloaded update. Triggers an app restart. */
  quitAndInstall(): void;
  onUpdateDownloaded(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
}

export interface UpdaterDeps {
  driver: UpdaterDriver;
  /** True while a sales call is in progress — installs must wait. */
  isInCall: () => boolean;
  /** Defaults to setTimeout; injectable for tests. Returns a cancel handle. */
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
  retryMs?: number;
  log?: (message: string, context?: Record<string, unknown>) => void;
}

export class UpdateManager {
  private readonly driver: UpdaterDriver;
  private readonly isInCall: () => boolean;
  private readonly schedule: (fn: () => void, ms: number) => { cancel: () => void };
  private readonly retryMs: number;
  private readonly log: (message: string, context?: Record<string, unknown>) => void;

  private updateDownloaded = false;
  private pendingRetry: { cancel: () => void } | null = null;

  constructor(deps: UpdaterDeps) {
    this.driver = deps.driver;
    this.isInCall = deps.isInCall;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.retryMs = deps.retryMs ?? UPDATE_DEFERRED_RETRY_MS;
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    this.driver.onUpdateDownloaded(() => {
      this.updateDownloaded = true;
      this.log('update downloaded; evaluating install');
      this.tryInstall();
    });
    this.driver.onError((error) => {
      this.log('updater error', { error: error.message });
    });
    this.driver.checkForUpdates();
  }

  /**
   * Called when a call ends so a deferred install can proceed immediately
   * instead of waiting for the next 15-minute tick.
   */
  onCallEnded(): void {
    if (this.updateDownloaded) {
      this.log('call ended; retrying deferred install');
      this.tryInstall();
    }
  }

  private tryInstall(): void {
    if (!this.updateDownloaded) {
      return;
    }
    if (this.isInCall()) {
      this.scheduleRetry();
      return;
    }
    this.cancelRetry();
    this.log('installing update (no active call)');
    this.driver.quitAndInstall();
  }

  private scheduleRetry(): void {
    // Per PRD §32: defer during a call, re-check in 15 minutes. Avoid stacking timers.
    if (this.pendingRetry) {
      return;
    }
    this.log('update deferred: call in progress, will retry', { retryMs: this.retryMs });
    this.pendingRetry = this.schedule(() => {
      this.pendingRetry = null;
      this.tryInstall();
    }, this.retryMs);
  }

  private cancelRetry(): void {
    this.pendingRetry?.cancel();
    this.pendingRetry = null;
  }
}

function defaultSchedule(fn: () => void, ms: number): { cancel: () => void } {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}
