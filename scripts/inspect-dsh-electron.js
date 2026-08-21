'use strict';

/**
 * Launch Electron in dev mode, load dsh web, then dump the send/stop button DOM.
 * Run: npx electron scripts/inspect-dsh-electron.js
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');

const DSH_URL = process.env.DSH_DESKTOP_URL || 'http://127.0.0.1:3081/';

let win;

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadURL(DSH_URL);

  // Wait for SPA to render, then inspect DOM
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents.executeJavaScript(`
        (function() {
          var results = {};

          // 1. Find all buttons in the page
          var buttons = document.querySelectorAll('button');
          results.buttons = [];
          for (var i = 0; i < buttons.length; i++) {
            var b = buttons[i];
            results.buttons.push({
              index: i,
              text: b.textContent.trim().substring(0, 50),
              className: b.className.substring(0, 200),
              id: b.id,
              ariaLabel: b.getAttribute('aria-label'),
              dataTestId: b.getAttribute('data-testid'),
              type: b.getAttribute('type'),
              disabled: b.disabled,
              visible: b.offsetParent !== null,
              rect: (function() {
                var r = b.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
              })(),
            });
          }

          // 2. Find textarea/input (chat input)
          var inputs = document.querySelectorAll('textarea, input[type="text"], div[contenteditable]');
          results.inputs = [];
          for (var i = 0; i < inputs.length; i++) {
            var el = inputs[i];
            results.inputs.push({
              tag: el.tagName,
              className: el.className.substring(0, 200),
              id: el.id,
              placeholder: el.getAttribute('placeholder'),
              ariaLabel: el.getAttribute('aria-label'),
              visible: el.offsetParent !== null,
            });
          }

          // 3. Find elements with send/stop/submit in class or aria-label
          var keywordEls = document.querySelectorAll(
            '[class*="send"], [class*="stop"], [class*="submit"], [class*="abort"], ' +
            '[class*="generat"], [class*="thinking"], [class*="stream"], ' +
            '[aria-label*="send" i], [aria-label*="stop" i], [aria-label*="submit" i], ' +
            '[aria-label*="abort" i], [aria-label*="cancel" i], [aria-label*="generat" i], ' +
            '[data-testid*="send"], [data-testid*="stop"], [data-testid*="submit"], [data-testid*="generat"]'
          );
          results.keywordElements = [];
          for (var i = 0; i < keywordEls.length; i++) {
            var el = keywordEls[i];
            results.keywordElements.push({
              tag: el.tagName,
              className: el.className.substring(0, 200),
              id: el.id,
              ariaLabel: el.getAttribute('aria-label'),
              dataTestId: el.getAttribute('data-testid'),
              text: el.textContent.trim().substring(0, 50),
              visible: el.offsetParent !== null,
            });
          }

          // 4. Find SVG icons inside buttons (send/stop often use SVG)
          var svgsInButtons = document.querySelectorAll('button svg');
          results.svgsInButtons = [];
          for (var i = 0; i < svgsInButtons.length; i++) {
            var svg = svgsInButtons[i];
            var btn = svg.closest('button');
            results.svgsInButtons.push({
              svgClass: svg.getAttribute('class') || '',
              svgDataIcon: svg.getAttribute('data-icon') || '',
              parentBtnClass: btn ? btn.className.substring(0, 150) : '',
              parentBtnAriaLabel: btn ? btn.getAttribute('aria-label') : '',
              parentBtnDataTestId: btn ? btn.getAttribute('data-testid') : '',
              visible: btn ? btn.offsetParent !== null : false,
            });
          }

          return JSON.stringify(results, null, 2);
        })()
      `, true).then((result) => {
        console.log('\n=== dsh DOM Inspection ===\n');
        console.log(result);
        app.quit();
      }).catch((err) => {
        console.error('Inspection failed:', err.message);
        app.quit();
      });
    }, 5000); // Wait 5s for SPA to fully render
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('Failed to load:', code, desc);
    console.error('Make sure dsh is running on', DSH_URL);
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
