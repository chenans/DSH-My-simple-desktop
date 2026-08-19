'use strict';

/**
 * bump-version.js — 一键升级版本号 + 添加更新日志 + 打包
 *
 * 用法：
 *   node scripts/bump-version.js patch "更新日志描述"
 *   node scripts/bump-version.js minor "更新日志描述"
 *   node scripts/bump-version.js major "更新日志描述"
 *
 * 示例：
 *   node scripts/bump-version.js patch "新增启动引导窗口和环境检测"
 *
 * 效果：
 *   1. package.json 版本号 +1
 *   2. CHANGELOG.md 顶部插入新版本条目
 *   3. 运行 electron-builder 打包（npm run dist）
 *   4. 输出安装包路径
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CHANGELOG_PATH = path.join(ROOT, 'CHANGELOG.md');
const RELEASE_DIR = path.join(ROOT, 'release');

// ── 解析参数 ────────────────────────────────────────────────────────────────

const bumpType = (process.argv[2] || 'patch').toLowerCase();
const description = process.argv[3] || '';

if (!['patch', 'minor', 'major'].includes(bumpType)) {
  console.error('用法: node scripts/bump-version.js <patch|minor|major> "更新说明"');
  process.exit(1);
}

// ── 读取当前版本 ─────────────────────────────────────────────────────────────

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'));
const oldVersion = pkg.version;
const parts = oldVersion.split('.').map(Number);

let newVersion;
switch (bumpType) {
  case 'major':
    newVersion = [parts[0] + 1, 0, 0].join('.');
    break;
  case 'minor':
    newVersion = [parts[0], parts[1] + 1, 0].join('.');
    break;
  case 'patch':
  default:
    newVersion = [parts[0], parts[1], parts[2] + 1].join('.');
    break;
}

// ── 写入 package.json ───────────────────────────────────────────────────────

pkg.version = newVersion;
fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
console.log(`✓ 版本号: ${oldVersion} → ${newVersion}`);

// ── 更新 CHANGELOG.md ───────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const header = `## ${newVersion} (${today})\n\n`;
const body = description
  ? `### 变更\n\n- ${description}\n`
  : '';
const entry = header + body + '\n';

const existing = fs.readFileSync(CHANGELOG_PATH, 'utf-8');
// 跳过标题行（# 更新日志），在第一个 ## 之前插入
const titleEnd = existing.indexOf('\n##');
if (titleEnd === -1) {
  // 空日志，追加
  fs.writeFileSync(CHANGELOG_PATH, existing + '\n' + entry, 'utf-8');
} else {
  const before = existing.slice(0, titleEnd + 1);
  const after = existing.slice(titleEnd + 1);
  fs.writeFileSync(CHANGELOG_PATH, before + '\n' + entry + after, 'utf-8');
}
console.log(`✓ CHANGELOG.md 已更新`);

// ── 打包 ─────────────────────────────────────────────────────────────────────

console.log(`\n▶ 正在打包 v${newVersion} ...\n`);

const result = spawnSync('npm', ['run', 'dist'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
});

if (result.status !== 0) {
  console.error(`\n✗ 打包失败 (exit code ${result.status})`);
  process.exit(result.status);
}

// ── 输出安装包路径 ─────────────────────────────────────────────────────────

console.log(`\n✓ 打包完成 v${newVersion}`);
if (fs.existsSync(RELEASE_DIR)) {
  const files = fs.readdirSync(RELEASE_DIR)
    .filter(f => f.endsWith('.exe') || f.endsWith('.msi') || f.endsWith('.zip'))
    .map(f => path.join(RELEASE_DIR, f));
  if (files.length > 0) {
    console.log('  安装包:');
    for (const f of files) {
      const size = (fs.statSync(f).size / 1024 / 1024).toFixed(1);
      console.log(`    ${f}  (${size} MB)`);
    }
  }
}

console.log(`\n✔ 完成！发布说明可复制自 CHANGELOG.md`);
