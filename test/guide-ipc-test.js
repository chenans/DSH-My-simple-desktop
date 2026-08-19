'use strict';
/**
 * Quick smoke test: open settings window, click the guide button,
 * verify IPC handler fires.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 500, height: 400,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Register required IPC handlers
  ipcMain.handle('settings:get', () => ({}));
  ipcMain.handle('settings:set', () => {});
  ipcMain.handle('app:info', () => ({ name: 'Test', version: '0.0.0' }));
  ipcMain.handle('app:log', () => {});
  ipcMain.handle('app:quit', () => app.quit());
  ipcMain.handle('updater:check', () => {});
  ipcMain.handle('shell:open-log-dir', () => {});
  ipcMain.handle('shell:open-workspace', () => {});
  ipcMain.handle('settings:choose-workspace', () => '');

  // The handler we're testing
  ipcMain.handle('app:open-guide', () => {
    console.log('✓ IPC app:open-guide 已触发');
    app.quit();
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'settings', 'settings.html'));
  win.webContents.once('did-finish-load', () => {
    // Click the guide button
    win.webContents.executeJavaScript('document.getElementById("openGuide").click()');
  });
});
