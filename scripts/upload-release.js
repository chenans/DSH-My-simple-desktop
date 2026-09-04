#!/usr/bin/env node
/**
 * One-shot script: create a GitHub Release for v0.1.18 and upload
 * all three installer .exe files as release assets.
 *
 * Usage: node scripts/upload-release.js
 *
 * Requires git credential helper to have a stored token for github.com.
 * The token must have repo scope (Personal Access Token).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = 'chenans/DSH-My-simple-desktop';
const TAG = 'v0.1.18';
const VERSION = '0.1.18';

// --- Get token from git credential helper ---
function getToken() {
  const input = 'protocol=https\nhost=github.com\n\n';
  const result = execSync('git credential fill', { input, encoding: 'utf8', timeout: 10000 });
  for (const line of result.split('\n')) {
    if (line.startsWith('password=')) {
      return line.slice('password='.length).trim();
    }
  }
  throw new Error('No token found in git credential helper');
}

// --- GitHub API helper ---
function apiCall(method, path, body, token, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) : null;
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'dsh-desktop-release-uploader',
    };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    if (method !== 'GET' && contentType) headers['Content-Type'] = contentType;

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${REPO}/${path}`,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, data: json, raw });
        } else {
          reject(new Error(`GitHub API ${method} ${path} → ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// --- Upload asset to release (different hostname: uploads.github.com) ---
function uploadAsset(uploadUrl, filePath, token) {
  return new Promise((resolve, reject) => {
    const fileData = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = fileData.length;

    // Parse upload_url — it looks like: https://uploads.github.com/repos/.../releases/123/assets{?name,label}
    const urlMatch = uploadUrl.match(/^(https:\/\/uploads\.github\.com\/[^{]+)/);
    if (!urlMatch) return reject(new Error(`Cannot parse upload_url: ${uploadUrl}`));
    const baseUrl = urlMatch[1];
    const fullUrl = `${baseUrl}?name=${encodeURIComponent(fileName)}`;

    const urlObj = new URL(fullUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'dsh-desktop-release-uploader',
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize,
      },
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`  [OK] ${fileName} uploaded (${(fileSize / 1048576).toFixed(1)} MB)`);
          resolve(json);
        } else {
          reject(new Error(`Upload ${fileName} → ${res.statusCode}: ${raw.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(fileData);
    req.end();
  });
}

// --- Main ---
async function main() {
  console.log('=== GitHub Release Uploader ===');
  console.log(`Repo: ${REPO}`);
  console.log(`Tag:  ${TAG}`);
  console.log();

  // 1. Get token
  console.log('[1/4] Getting token from git credential helper...');
  const token = getToken();
  console.log(`  Token: ${token.slice(0, 4)}...${token.slice(-4)} (len=${token.length})`);

  // 2. Check if release already exists
  console.log();
  console.log('[2/4] Checking for existing release...');
  let release;
  try {
    const resp = await apiCall('GET', `releases/tags/${TAG}`, null, token);
    release = resp.data;
    console.log(`  Found existing release: id=${release.id}, url=${release.html_url}`);
  } catch (err) {
    console.log(`  No existing release: ${err.message}`);
    // 3. Create release
    console.log();
    console.log('[3/4] Creating new release...');
    const releaseBody = `## v${VERSION} — dsh 崩溃恢复全面修复

### 修复（6 个崩溃恢复问题）

- **崩溃重启不清理残留锁** — 抽取 \`cleanupDshLocks()\` 独立函数，重启前安全清理 \`~/.dsh/task-board/ledger-v2.lock\`（仅删 owner PID 已死的锁），避免 dsh 抢不到锁导致崩溃循环
- **\`bootstrapDsh\` 参数传错** — 重启路径误将超时数字当 \`preferSystem\` 传入。新增模块级变量 \`dshPreferSystem\` 缓存启动时解析值，重启时复用
- **\`dshRestarts\` 计数器不重置** — 崩溃重启成功后不归零，逐渐耗尽重试预算。现重启成功后立即重置为 0
- **\`wmic\` 已废弃** — Win11 23H2+ 移除 wmic，\`killStaleDshProcesses\` 静默失败。改用 PowerShell \`Get-CimInstance Win32_Process\` 替代
- **崩溃后不杀残留进程树** — 重启前调 \`killDshTree()\` + \`cleanupDshLocks()\`；\`waitForHealthyUrl\` 失败后 \`killDshTree()\` 兜底
- **渲染进程崩溃只能重载一次** — \`rendererReloaded\` 置 true 后永不复位。\`did-finish-load\` 成功后复位为 false

### 下载

| 版本 | 文件 | 大小 | 适用人群 |
|------|------|------|---------|
| 完整版 | \`DSH.My.Simple.Desktop-${VERSION}-Setup.exe\` | 151.8 MB | 没装 dsh / 离线环境，开箱即用 |
| 精简版 | \`DSH.My.Simple.Desktop-${VERSION}-Lite-Setup.exe\` | 81.5 MB | 本地已装 dsh 的用户 |
| 插件版 | \`DSH.My.Simple.Desktop-${VERSION}-Plugins-Setup.exe\` | 278.3 MB | 内网/离线团队分发，内置插件快照 |

### 安装说明

1. 下载对应版本的 Setup.exe
2. 双击运行安装（如提示 SmartScreen，点击"仍要运行"）
3. 安装完成后从开始菜单启动"DSH My Simple Desktop"

> 完整版和插件版首次启动会自动部署 dsh 运行时到 \`%USERPROFILE%\\.dsh-desktop\`，请耐心等待进度条完成。`;

    const createResp = await apiCall('POST', 'releases', {
      tag_name: TAG,
      name: `v${VERSION} — dsh 崩溃恢复全面修复`,
      body: releaseBody,
      draft: false,
      prerelease: false,
    }, token);
    release = createResp.data;
    console.log(`  Created release: id=${release.id}, url=${release.html_url}`);
  }

  // 4. Upload assets
  console.log();
  console.log('[4/4] Uploading installer assets...');
  const releaseDir = path.join(__dirname, '..', 'release');
  const assets = [
    `DSH My Simple Desktop-${VERSION}-Setup.exe`,
    `DSH My Simple Desktop-${VERSION}-Lite-Setup.exe`,
    `DSH My Simple Desktop-${VERSION}-Plugins-Setup.exe`,
  ];

  const uploadUrl = release.upload_url;
  let uploaded = 0;
  let skipped = 0;

  for (const assetName of assets) {
    const filePath = path.join(releaseDir, assetName);
    if (!fs.existsSync(filePath)) {
      console.log(`  [SKIP] ${assetName} — file not found`);
      skipped++;
      continue;
    }

    // Check if asset already exists
    const existing = (release.assets || []).find(a => a.name === assetName);
    if (existing) {
      console.log(`  [SKIP] ${assetName} — already uploaded`);
      skipped++;
      continue;
    }

    const sizeMB = (fs.statSync(filePath).size / 1048576).toFixed(1);
    console.log(`  Uploading ${assetName} (${sizeMB} MB)...`);
    try {
      await uploadAsset(uploadUrl, filePath, token);
      uploaded++;
    } catch (err) {
      console.error(`  [FAIL] ${assetName}: ${err.message}`);
    }
  }

  console.log();
  console.log('=== Summary ===');
  console.log(`  Uploaded: ${uploaded}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Release:  ${release.html_url}`);
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
