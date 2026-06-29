'use strict';

const { contextBridge } = require('electron');

// Expose a minimal, safe API to the renderer so the web app
// can detect it's running inside Electron.
contextBridge.exposeInMainWorld('electronApp', {
  isDesktop: true,
  platform: process.platform, // 'darwin' | 'win32' | 'linux'
  version: process.env.npm_package_version || '',
});
