# DSH My Simple Desktop

[![GitHub Release](https://img.shields.io/github/v/release/chenans/DSH-My-simple-desktop)](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/chenans/DSH-My-simple-desktop/total)](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个简单的 Windows 桌面壳：用 Electron 把 DeepSeek Harness 的 `dsh web` 界面封装成桌面应用，**内置 dsh 运行时 + 自动检查更新 + 下载进度窗口（可反复查看）+ 自动重试 + 下载取消/重试 + 用量统计（按模型/Provider） + 模型配置教程 + 退出/安装前会话任务检查**。

> 适合团队内部使用，让没有 Node.js 环境或网络不好的同事也能直接双击运行 dsh。

**English:** A minimal Electron wrapper for DeepSeek Harness (`dsh web`). Bundles a portable Node.js + dsh runtime so non-technical users can install and run dsh with zero dependencies. Features: auto-update via GitHub Release with reusable download progress window, auto-retry, download cancel/retry, usage statistics (tokens by model/provider/sessions/projects), crash recovery, system tray with usage/guide entries and download submenu, close-guard (prevents accidental quit during LLM generation, also applies to tray quit and update install), model config guide. Windows x64 only.

## 📥 直接下载

前往 **[GitHub Releases](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)** 下载，按你的环境选择：

| 版本 | 下载 | 大小 | 适用人群 |
|------|------|------|---------|
| **完整版** | [DSH.My.Simple.Desktop-0.1.45-Setup.exe](https://github.com/chenans/DSH-My-simple-desktop/releases/download/v0.1.45/DSH.My.Simple.Desktop-0.1.45-Setup.exe) | 151.8 MB | 没装 dsh / 离线环境，**无需任何预装**，开箱即用 |
| **精简版** | [DSH.My.Simple.Desktop-0.1.45-Lite-Setup.exe](https://github.com/chenans/DSH-My-simple-desktop/releases/download/v0.1.45/DSH.My.Simple.Desktop-0.1.45-Lite-Setup.exe) | 81.5 MB | 本地已装 dsh 的用户，安装快 |

- **完整版**：内置完整 dsh 运行时（node.exe + 全部依赖），首次启动自动安装环境到 `%USERPROFILE%\.dsh-desktop` 并加入命令行 PATH；每次启动自动检查 dsh 更新
- **精简版**：使用系统已安装的 dsh；若系统没有 dsh 会提示安装 dsh 或改用完整版

## 功能

- **内置 dsh 运行时** — 安装包自带 node.exe + dsh 依赖树，用户不需要提前安装 Node.js 或 dsh CLI
- **启动引导** — 启动时弹出进度窗口，显示检测环境 → 安装环境 → 启动引擎 → 就绪，避免以为卡死
- **智能 dsh 选择** — 系统有安装 dsh 就用系统的（优先最新版），没有就用内置的；系统 dsh 启动失败自动回退内置
- **自动更新 dsh** — 每次启动后台检查 npm 上有无新版 @deepseek-ai/dsh，有则下载更新（不阻塞启动，失败跳过）
- **自动更新桌面应用** — 三种触发方式：
  - 菜单栏"帮助 → 检查更新"手动检查
  - 启动后 30 秒自动检查 GitHub Release
  - 每 4 小时定时轮询，发现新版本右下角弹窗通知
- **下载进度窗口** — 下载更新时显示进度条、已下载/总大小、下载速度；下载失败自动重试（最多 3 次，间隔 5 秒）；窗口可反复打开（关闭不影响下载），支持取消下载和重新下载
- **用量统计** — 菜单栏"帮助 → 用量统计"或托盘菜单"用量统计"：
  - 读取 `~/.dsh/dsh-usage/usage-ledger.json`，统计真实 Token 使用量
  - 按模型统计（如 scnet-base/GLM-5-Base）：输入/输出/缓存读取/缓存写入 Token + 调用次数
  - 按 Provider 统计：各 Provider 的 Token 使用量 + 余额
  - 按时间分布柱状图（粒度：天/周/月/年/自动），鼠标悬浮显示详细 Tooltip
  - 按项目统计表格（会话数、交互轮次、Token、最后使用时间）
  - 时间范围筛选：全部 / 7天 / 30天 / 90天 / 1年 / **自定义日期范围**（含本月/上月/今年/去年快捷按钮）
- **崩溃恢复** — dsh 子进程崩溃自动重启（退避重试），渲染进程崩溃自动重载
- **系统托盘** — 显示/隐藏窗口、打开工作区、用量统计、模型配置教程、设置、退出；下载更新时显示二级菜单（进度详情/查看下载详情/取消下载/安装更新并重启）
- **开机自启** — 登录 Windows 后后台静默启动（`--hidden` 参数）
- **设置窗口** — 工作区目录、关闭行为（隐藏到托盘/直接退出）、开机自启开关
- **模型配置教程** — 菜单栏"帮助 → 模型配置教程"或托盘菜单"模型配置教程"，内置图文教程，手把手教配置第三方 OpenAI 兼容网关
- **会话任务检查（close-guard）** — 以下操作前检查是否有大模型任务正在进行，有则弹窗确认（避免中断会话/数据丢失）：
  - 窗口关闭按钮（未开启关闭到托盘时）
  - 托盘"退出"菜单
  - 下载完成后自动安装更新
  - 托盘"安装更新并重启"菜单
  - 进度窗口"安装更新并重启"按钮
  - 托盘"重试下载"成功后自动安装
- **单实例锁** — 防止重复启动

## 菜单栏使用说明

应用启用了 `autoHideMenuBar`，菜单栏默认隐藏。**按 `Alt` 键**即可临时显示菜单栏，包含：

- **文件** — 退出
- **编辑** — 撤销/重做/剪切/复制/粘贴
- **视图** — 刷新/开发者工具/全屏
- **帮助** — 检查更新 / 用量统计 / 模型配置教程 / 关于

## 不是什么

- ❌ 不是 DeepSeek 官方产品
- ❌ 没有崩溃信息上传
- ❌ 没有多语言界面
- ❌ 没有 MSIX 商店包

## ⚠️ 关于代码签名

安装包默认使用**自签名证书**签名。Windows SmartScreen 仍可能弹出警告（自签名证书不在微软信任链中），点击"更多信息 → 仍要运行"即可。

### 生成自签名证书并签名

```powershell
# 1. 生成自签名证书（首次执行）
npm run cert:create
# → 输出 build/certs/codesign.pfx + codesign.cer
# → 自动安装到本机 Trusted Root（本机不再弹警告）

# 2. 设置环境变量后打包（自动签名）
$env:CSC_LINK = "build/certs/codesign.pfx"
$env:CSC_KEY_PASSWORD = "<你设置的密码>"
npm run dist          # 完整版
npm run dist:lite     # 精简版

# 3. 对已构建的 exe 补签名（无需重新打包）
npm run sign
# 或指定文件
powershell -File scripts/sign-exe.ps1 -FilePath "release/xxx-Setup.exe"
```

### 让其他机器信任自签名证书

将 `build/certs/codesign.cer` 分发给同事，双击 → 安装证书 → 本地计算机 → 受信任的根证书颁发机构。或通过 AD 组策略批量推送。

### 商业签名（消除 SmartScreen）

如需完全消除 SmartScreen 警告，需购买商业 OV/EV 证书或订阅 [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/)（~$9.99/月）。配置 `CSC_LINK` 指向商业 .pfx 后，打包流程不变。

## 架构

```
Electron 壳 (src/main.js)
  ├─ 拉起 dsh web（空闲端口）→ 等待就绪 → 主窗口
  ├─ 系统托盘 / 开机自启
  ├─ 设置窗口 (src/settings/settings.html)
  └─ 崩溃恢复（dsh 退避重启）

dsh web（子进程，127.0.0.1:<port>）
  └─ DeepSeek Harness SPA + API
```

## 快速开始

### 依赖

```bat
npm.cmd install
```

> 若 Electron 二进制下载失败，设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后执行
> `node node_modules\electron\install.js`。

### 运行

```bat
npm.cmd start          # 生产路径：拉起 dsh → 打开窗口
npm.cmd run dev        # 开发模式：直连已有 dsh web（默认 :3080）
npm.cmd test           # 单元测试
```

### 打包安装包

先全局安装 dsh（用于提取运行时）：

```bat
npm install -g @deepseek-ai/dsh
```

然后：

```bat
npm.cmd run build:runtime   # 构建内嵌 dsh 运行时（dsh/ 目录，~340MB）
npm.cmd run dist            # 打包完整版 NSIS 安装包
npm.cmd run dist:lite       # 打包精简版 NSIS 安装包（不含内置 dsh）
```

产物在 `release/` 目录：

| 产物 | 大小 | 说明 |
|------|------|------|
| `DSH My Simple Desktop-0.1.x-Setup.exe` | ~152 MB | **完整版**：内嵌 dsh 运行时，无 dsh 环境可直接用（离线环境/同事机器） |
| `DSH My Simple Desktop-0.1.x-Lite-Setup.exe` | ~82 MB | **精简版**：仅应用本体，本地已装 dsh 的用户安装快；启动时优先用系统 dsh，没有则提示装 dsh 或用完整版 |

> 完整版**不依赖系统 Node.js 或 dsh CLI**——它内嵌了便携版 Node.js + 完整 dsh 依赖树。
> 两个版本的**运行时选择逻辑相同**：每次启动先检测系统 dsh，有则用本地的；本地没有才用内置（完整版）。

## 环境变量

| 变量 | 作用 |
|------|------|
| `DSH_DESKTOP_DSH_BIN` | 显式指定 dsh 可执行文件路径 |
| `DSH_DESKTOP_URL` | `--dev` 模式加载的 URL（默认 `http://127.0.0.1:3080`） |
| `DSH_DESKTOP_WORKSPACE` | dsh 进程工作目录 |
| `DSH_DESKTOP_USER_DATA` | 覆盖 userData（测试/多实例隔离） |
| `DSH_DESKTOP_OFFLINE` | 设为 `1` 跳过 dsh 内核更新检查（插件版启动时自动注入） |

## 目录结构

```
├─ src/
│  ├─ main.js                 主进程（进程管理/托盘/IPC/生命周期/菜单栏）
│  ├─ preload.js              contextBridge
│  ├─ splash/splash.html      启动引导页面
│  ├─ help/model-guide.html   模型配置教程
│  ├─ settings/settings.html  设置窗口
│  ├─ usage/usage.html        用量统计窗口
│  ├─ updater/download-progress.html  下载更新进度窗口
│  └─ lib/
│     ├─ port.js              端口扫描
│     ├─ settings.js          设置持久化
│     ├─ dsh-resolve.js       dsh 命令解析（含 forceBundled 参数）
│     ├─ runtime-updater.js   dsh 运行时自动更新（支持 DSH_DESKTOP_OFFLINE）
│     ├─ plugin-deployer.js   插件版首次启动部署逻辑（幂等非破坏性）
│     ├─ update-checker.js    GitHub Release 自动更新检查器
│     └─ usage-stats.js       用量统计数据读取与聚合
├─ scripts/                   构建脚本
│  ├─ snapshot-plugin-layer.mjs  插件快照核心模块（可单测）
│  └─ build-plugin-layer.ps1     插件快照编排脚本
├─ assets/                    图标资源
├─ electron-builder.yml       完整版打包配置
├─ electron-builder.lite.yml  精简版打包配置
├─ electron-builder.plugins.yml  插件版打包配置
└─ release/                   打包产物
```

## 日志

- 应用日志：`%APPDATA%\DSH My Simple Desktop\logs\main.log`
- 开发模式：`%APPDATA%\DSH My Simple Desktop (dev)\logs\main.log`

## License

MIT
