'use strict';

const { app, BrowserWindow, shell, dialog, nativeImage, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

// The production URL — where your Vercel app is deployed.
// Update this to match your actual domain.
const APP_URL = process.env.APP_URL || 'https://nikhil-gems.vercel.app';

// ── Auto-updater config ──────────────────────────────────────────
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater(win) {
  autoUpdater.on('update-available', () => {
    win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('ng-update', { detail: 'downloading' }))`
    ).catch(() => {});
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update Ready',
      message: 'A new version of Nikhil Gems is ready.',
      detail: 'The app will restart to apply the update.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-updater error:', err.message);
  });

  // Check immediately, then every 4 hours
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ── Window ───────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Allow loading the remote Vercel URL
      webSecurity: true,
    },
    title: 'Nikhil Gems',
    backgroundColor: '#FAF7F2',
    show: false, // shown after ready-to-show for flicker-free load
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
  });

  // No default menu (keeps it clean)
  Menu.setApplicationMenu(null);

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadURL(APP_URL);
  }

  // Show when content is ready (avoids white flash)
  win.once('ready-to-show', () => win.show());

  // Open <a target="_blank"> links in the system browser, not Electron
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(APP_URL)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Prevent navigation away from the app URL
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith('http://localhost')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

// ── App lifecycle ────────────────────────────────────────────────
app.whenReady().then(() => {
  const win = createWindow();

  if (!isDev) setupAutoUpdater(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
