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
const TAG = 'v0.1.38';
const VERSION = '0.1.38';

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
    const releaseBody = `## v${VERSION} — 用量统计图表与缓存写入修复

### 修复

- **按时间分布图折线与柱状不一致** — 折线此前选用"会话数"（每时段仅 0~2 个），与柱状图的 Token 消耗趋势相反，看起来两套数据对不上。改为优先叠加"调用次数"（与 Token 消耗直接正相关），仅当无调用数据时回退为会话数
- **"缓存写入"一直显示 0** — 数据源（usage-ledger 与会话记录）本身未记录缓存写入量（API 计费仅区分 cache hit/miss）。不再用误导性的 0 展示：总计卡片与模型/Provider 明细表显示"未记录"并附悬停说明

### 下载

| 版本 | 文件 | 大小 | 适用人群 |
|------|------|------|---------|
| 完整版 | \`DSH.My.Simple.Desktop-${VERSION}-Setup.exe\` | ~152 MB | 没装 dsh / 离线环境，开箱即用 |
| 精简版 | \`DSH.My.Simple.Desktop-${VERSION}-Lite-Setup.exe\` | ~81 MB | 本地已装 dsh 的用户 |
| 插件版 | \`DSH.My.Simple.Desktop-${VERSION}-Plugins-Setup.exe\` | ~278 MB | 内网/离线团队分发，内置插件快照 |

### 安装说明

1. 下载对应版本的 Setup.exe
2. 双击运行安装（如提示 SmartScreen，点击"仍要运行"）
3. 安装完成后从开始菜单启动"DSH My Simple Desktop"
4. 按 \`Alt\` 键显示菜单栏，访问"帮助"菜单使用检查更新、用量统计、模型配置教程等功能

> 完整版和插件版首次启动会自动部署 dsh 运行时到 \`%USERPROFILE%\\.dsh-desktop\`，请耐心等待进度条完成。`;

    const createResp = await apiCall('POST', 'releases', {
      tag_name: TAG,
      name: `v${VERSION} — 用量统计图表与缓存写入修复`,
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
