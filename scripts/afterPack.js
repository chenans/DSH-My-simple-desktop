'use strict';

/**
 * electron-builder afterPack hook (Windows):
 * embeds the app icon + version metadata into the packaged exe via rcedit.
 *
 * Why not win.signAndEditExecutable? That path needs the winCodeSign toolchain,
 * whose 7z extraction requires the SeCreateSymbolicLinkPrivilege (admin or
 * Developer Mode). rcedit is a plain exe — no admin needed, works everywhere.
 *
 * rcedit binary: build/rcedit/rcedit-x64.exe (extracted from the official
 * winCodeSign package; see scripts/fetch-rcedit.ps1 to refresh it).
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PRODUCT_NAME = 'DeepSeek Harness Desktop';
const COMPANY = 'dsh-desktop contributors';

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const rcedit = path.join(__dirname, '..', 'build', 'rcedit', 'rcedit-x64.exe');
  const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
  for (const f of [exe, rcedit, ico]) {
    if (!fs.existsSync(f)) {
      console.warn(`[afterPack] missing ${f} — skipping icon/version embed`);
      return;
    }
  }

  const version = context.packager.appInfo.version;
  const args = [
    exe,
    '--set-icon', ico,
    '--set-version-string', 'ProductName', PRODUCT_NAME,
    '--set-version-string', 'FileDescription', PRODUCT_NAME,
    '--set-version-string', 'CompanyName', COMPANY,
    '--set-version-string', 'LegalCopyright', `Copyright © 2025 ${COMPANY}`,
    '--set-file-version', version,
    '--set-product-version', version,
  ];

  console.log(`[afterPack] rcedit ${path.basename(exe)} icon+version (${version})`);
  await new Promise((resolve, reject) => {
    const child = spawn(rcedit, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`rcedit exited with code ${code}`)),
    );
  });
};
