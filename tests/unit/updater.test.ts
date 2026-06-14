import { describe, expect, it, vi } from 'vitest';
import { UpdateManager, type UpdaterDriver } from '../../src/main/services/updater';

function createDriver(): UpdaterDriver & {
  emitDownloaded: () => void;
  emitError: (error: Error) => void;
  quitAndInstall: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
} {
  let downloadedHandler: (() => void) | null = null;
  let errorHandler: ((error: Error) => void) | null = null;
  return {
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
    onUpdateDownloaded: (handler) => {
      downloadedHandler = handler;
    },
    onError: (handler) => {
      errorHandler = handler;
    },
    emitDownloaded: () => downloadedHandler?.(),
    emitError: (error) => errorHandler?.(error),
  };
}

/** Manual scheduler so the 15-minute retry can be driven deterministically. */
function createScheduler() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  return {
    schedule: (fn: () => void) => {
      const entry = { fn, cancelled: false };
      pending.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    runNext: () => {
      const entry = pending.find((p) => !p.cancelled);
      if (entry) {
        entry.cancelled = true;
        entry.fn();
      }
    },
    activeCount: () => pending.filter((p) => !p.cancelled).length,
  };
}

describe('UpdateManager', () => {
  it('installs immediately when no call is active', () => {
    const driver = createDriver();
    const manager = new UpdateManager({ driver, isInCall: () => false });
    manager.start();

    expect(driver.checkForUpdates).toHaveBeenCalledOnce();
    driver.emitDownloaded();

    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('never installs during a call (PRD §32)', () => {
    const driver = createDriver();
    const scheduler = createScheduler();
    const manager = new UpdateManager({
      driver,
      isInCall: () => true,
      schedule: scheduler.schedule,
    });
    manager.start();
    driver.emitDownloaded();

    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(scheduler.activeCount()).toBe(1); // a retry is scheduled
  });

  it('retries after the deferral window and installs once the call ended', () => {
    const driver = createDriver();
    const scheduler = createScheduler();
    let inCall = true;
    const manager = new UpdateManager({
      driver,
      isInCall: () => inCall,
      schedule: scheduler.schedule,
    });
    manager.start();
    driver.emitDownloaded();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();

    // First retry fires while still in call → still deferred, re-scheduled.
    scheduler.runNext();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();
    expect(scheduler.activeCount()).toBe(1);

    // Call ends, next retry installs.
    inCall = false;
    scheduler.runNext();
    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('installs as soon as the call ends without waiting for the retry tick', () => {
    const driver = createDriver();
    const scheduler = createScheduler();
    let inCall = true;
    const manager = new UpdateManager({
      driver,
      isInCall: () => inCall,
      schedule: scheduler.schedule,
    });
    manager.start();
    driver.emitDownloaded();
    expect(driver.quitAndInstall).not.toHaveBeenCalled();

    inCall = false;
    manager.onCallEnded();

    expect(driver.quitAndInstall).toHaveBeenCalledOnce();
    expect(scheduler.activeCount()).toBe(0); // pending retry was cancelled
  });

  it('does not stack retry timers when downloaded fires repeatedly during a call', () => {
    const driver = createDriver();
    const scheduler = createScheduler();
    const manager = new UpdateManager({
      driver,
      isInCall: () => true,
      schedule: scheduler.schedule,
    });
    manager.start();

    driver.emitDownloaded();
    driver.emitDownloaded();

    expect(scheduler.activeCount()).toBe(1);
  });

  it('ignores call-ended when no update is pending', () => {
    const driver = createDriver();
    const manager = new UpdateManager({ driver, isInCall: () => false });
    manager.start();

    manager.onCallEnded();

    expect(driver.quitAndInstall).not.toHaveBeenCalled();
  });
});
