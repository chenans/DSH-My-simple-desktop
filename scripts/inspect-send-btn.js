'use strict';

/**
 * Inspect the send button state during an active LLM task.
 * Loads dsh, types a message, sends it, then checks the button state while generating.
 * Run: npx electron scripts/inspect-send-btn.js
 */

const { app, BrowserWindow } = require('electron');

const DSH_URL = process.env.DSH_DESKTOP_URL || 'http://127.0.0.1:3081/';

let win;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function checkSendButton() {
  const result = await win.webContents.executeJavaScript(`
    (function() {
      // Find the send button by aria-label or class
      var btn = document.querySelector('button.uV2eYG_primary');
      if (!btn) {
        // Try by aria-label
        var allBtns = document.querySelectorAll('button');
        for (var i = 0; i < allBtns.length; i++) {
          var label = allBtns[i].getAttribute('aria-label') || '';
          if (label.indexOf('发送') !== -1 || label.indexOf('停止') !== -1 || label.indexOf('中断') !== -1 || label.indexOf('stop') !== -1 || label.indexOf('abort') !== -1) {
            btn = allBtns[i];
            break;
          }
        }
      }
      if (!btn) return JSON.stringify({ found: false });

      // Get SVG info to identify the icon
      var svg = btn.querySelector('svg');
      var svgPaths = btn.querySelectorAll('svg path');
      var pathData = [];
      for (var i = 0; i < svgPaths.length; i++) {
        pathData.push(svgPaths[i].getAttribute('d') || '');
      }

      return JSON.stringify({
        found: true,
        className: btn.className,
        ariaLabel: btn.getAttribute('aria-label'),
        disabled: btn.disabled,
        title: btn.getAttribute('title'),
        visible: btn.offsetParent !== null,
        rect: (function() {
          var r = btn.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })(),
        svgClass: svg ? svg.getAttribute('class') : null,
        svgPathCount: pathData.length,
        svgPathData: pathData,
        innerHTML: btn.innerHTML.substring(0, 500),
      });
    })()
  `, true);
  return JSON.parse(result);
}

app.whenReady().then(async () => {
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

  win.webContents.on('did-finish-load', async () => {
    console.log('\n=== Send Button State Inspection ===\n');

    // Wait for SPA to render
    await sleep(5000);

    // State 1: Idle (no text in input)
    console.log('--- State 1: Idle (no text) ---');
    let state1 = await checkSendButton();
    console.log(JSON.stringify(state1, null, 2));

    // Type some text into the textarea
    await win.webContents.executeJavaScript(`
      (function() {
        var textarea = document.querySelector('textarea.uV2eYG_input');
        if (textarea) {
          textarea.focus();
          // Simulate typing
          var nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(textarea, 'Hello, what is 1+1?');
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed';
        }
        return 'textarea not found';
      })()
    `, true);

    await sleep(1000);

    // State 2: Text entered, ready to send
    console.log('\n--- State 2: Text entered, ready to send ---');
    let state2 = await checkSendButton();
    console.log(JSON.stringify(state2, null, 2));

    // Click the send button
    await win.webContents.executeJavaScript(`
      (function() {
        var btn = document.querySelector('button.uV2eYG_primary');
        if (btn && !btn.disabled) {
          btn.click();
          return 'clicked';
        }
        return 'btn not clickable: ' + (btn ? 'disabled=' + btn.disabled : 'not found');
      })()
    `, true);

    // Check button state during generation (check multiple times)
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      let state = await checkSendButton();
      console.log(`\n--- State ${3 + i}: During generation (${(i + 1) * 1000}ms after send) ---`);
      console.log(JSON.stringify(state, null, 2));
      
      // If button is disabled again, generation might be done
      if (state.disabled && i > 1) {
        console.log('\nButton disabled again — generation likely finished');
        break;
      }
    }

    // Final state after generation
    await sleep(2000);
    console.log('\n--- Final State: After generation ---');
    let finalState = await checkSendButton();
    console.log(JSON.stringify(finalState, null, 2));

    app.quit();
  });

  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('Failed to load:', code, desc);
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
