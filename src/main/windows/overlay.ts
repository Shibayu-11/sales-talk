import { app, BrowserWindow, screen } from 'electron';
import { join } from 'node:path';

/**
 * Overlay window. Per PRD §12 and §4.3:
 * - Transparent, frameless, always-on-top, click-through by default.
 * - NSWindowSharingNone via setContentProtection(true) to prevent capture during screen share.
 * - visibleOnAllWorkspaces + screen-saver level so it survives Zoom fullscreen.
 */
export function createOverlayWindow(): BrowserWindow {
  const primary = screen.getPrimaryDisplay();
  const width = 380;
  const height = 600;

  const win = new BrowserWindow({
    width,
    height,
    x: primary.workArea.x + primary.workArea.width - width - 20,
    y: primary.workArea.y + 80,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    // Avoid focus stealing during meetings.
    focusable: false,
    // Per PRD §12.10 fallback strategy.
    backgroundColor: '#00000001',
    webPreferences: {
      preload: join(app.getAppPath(), 'out/preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Per PRD §12.6 防御線1: NSWindowSharingNone.
  win.setContentProtection(true);

  // Per PRD §4.3
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  // Click-through by default; renderer toggles via IPC on hover.
  win.setIgnoreMouseEvents(true, { forward: true });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay/index.html`);
  } else {
    void win.loadFile(join(app.getAppPath(), 'out/renderer/overlay/index.html'));
  }

  return win;
}
