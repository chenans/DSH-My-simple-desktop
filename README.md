# DSH My Simple Desktop

[![GitHub Release](https://img.shields.io/github/v/release/chenans/DSH-My-simple-desktop)](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/chenans/DSH-My-simple-desktop/total)](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

一个简单的 Windows 桌面壳：用 Electron 把 DeepSeek Harness 的 `dsh web` 界面封装成桌面应用，**内置 dsh 运行时 + 自动检查更新 + 模型配置教程**。

> 适合团队内部使用，让没有 Node.js 环境或网络不好的同事也能直接双击运行 dsh。

## 📥 直接下载

前往 **[GitHub Releases](https://github.com/chenans/DSH-My-simple-desktop/releases/latest)** 下载，按你的环境选择：

| 版本 | 下载 | 大小 | 适用人群 |
|------|------|------|---------|
| **完整版** | [DSH.My.Simple.Desktop-0.1.13-Setup.exe](https://github.com/chenans/DSH-My-simple-desktop/releases/download/v0.1.13/DSH.My.Simple.Desktop-0.1.13-Setup.exe) | 151.8 MB | 没装 dsh / 离线环境，**无需任何预装**，开箱即用 |
| **精简版** | [DSH.My.Simple.Desktop-0.1.13-Lite-Setup.exe](https://github.com/chenans/DSH-My-simple-desktop/releases/download/v0.1.13/DSH.My.Simple.Desktop-0.1.13-Lite-Setup.exe) | 81.5 MB | 本地已装 dsh 的用户，安装快 |

- **完整版**：内置完整 dsh 运行时（node.exe + 全部依赖），首次启动自动安装环境到 `%USERPROFILE%\.dsh-desktop` 并加入命令行 PATH；每次启动自动检查 dsh 更新
- **精简版**：使用系统已安装的 dsh；若系统没有 dsh 会提示安装 dsh 或改用完整版

## 功能

- **内置 dsh 运行时** — 安装包自带 node.exe + dsh 依赖树，用户不需要提前安装 Node.js 或 dsh CLI
- **启动引导** — 启动时弹出进度窗口，显示检测环境 → 安装环境 → 启动引擎 → 就绪，避免以为卡死
- **智能 dsh 选择** — 系统有安装 dsh 就用系统的（优先最新版），没有就用内置的；系统 dsh 启动失败自动回退内置
- **自动更新 dsh** — 每次启动后台检查 npm 上有无新版 @deepseek-ai/dsh，有则下载更新（不阻塞启动，失败跳过）
- **崩溃恢复** — dsh 子进程崩溃自动重启（退避重试），渲染进程崩溃自动重载
- **系统托盘** — 显示/隐藏窗口、打开工作区、设置、退出
- **开机自启** — 登录 Windows 后后台静默启动（`--hidden` 参数）
- **设置窗口** — 工作区目录、关闭行为、开机自启开关
- **模型配置教程** — 内置图文教程，手把手教配置第三方 OpenAI 兼容网关
- **崩溃恢复** — dsh 子进程崩溃自动重启（最多 5 次退避）
- **单实例锁** — 防止重复启动

## 不是什么

- ❌ 不是 DeepSeek 官方产品
- ❌ 没有自动更新桌面版本的功能（electron-updater 骨架保留但未接入更新源）
- ❌ 没有崩溃信息上传
- ❌ 没有多语言界面
- ❌ 没有 MSIX 商店包

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
| `DSH My Simple Desktop-0.1.x-Setup.exe` | ~162 MB | **完整版**：内嵌 dsh 运行时，无 dsh 环境可直接用（离线环境/同事机器） |
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

## 目录结构

```
├─ src/
│  ├─ main.js                 主进程（进程管理/托盘/IPC/生命周期）
│  ├─ preload.js              contextBridge
│  ├─ splash/splash.html      启动引导页面
│  ├─ help/model-guide.html   模型配置教程
│  ├─ settings/settings.html  设置窗口
│  └─ lib/
│     ├─ port.js              端口扫描
│     ├─ settings.js          设置持久化
│     ├─ dsh-resolve.js       dsh 命令解析
│     ├─ runtime-updater.js   dsh 运行时自动更新
│     └─ updater.js           electron-updater 封装（未接入更新源）
├─ scripts/                   构建脚本
├─ assets/                    图标资源
├─ electron-builder.yml       打包配置
└─ release/                   打包产物
```

## 日志

- 应用日志：`%APPDATA%\DSH My Simple Desktop\logs\main.log`
- 开发模式：`%APPDATA%\DSH My Simple Desktop (dev)\logs\main.log`

## License

MIT
