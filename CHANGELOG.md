# 更新日志


## 0.1.17 (2026-08-22)

### 新增
- **自签名代码签名** — 支持自签名证书签名 exe，消除"未知发布者"警告
  - 新增 `scripts/create-self-signed-cert.ps1`：生成自签名代码签名证书，导出 .pfx + .cer，自动安装到本机 Trusted Root
  - 新增 `scripts/sign-exe.ps1`：对已构建的 exe 补签名（支持 signtool.exe 和 PowerShell fallback）
  - 三个 electron-builder yml 保持 `signAndEditExecutable: false`（winCodeSign 需管理员权限），改用 post-build `sign-exe.ps1` 补签名（SHA256）
  - `package.json` 新增 `cert:create` 和 `sign` scripts
  - `.gitignore` 排除 `build/certs/`
- **插件版安装包** — 在完整版基础上内置作者本地 dsh 插件/presets 快照，供内网/离线团队开箱即用
  - 新增 `electron-builder.plugins.yml` 打包配置，产物名 `*-Plugins-Setup.exe`
  - 新增 `scripts/snapshot-plugin-layer.mjs` 快照核心模块：差分 `~/.dsh/profiles/web/node_modules` 与内置 `dsh/node_modules`，仅打包增量包；纳入 `profiles/web/package.json`（含 `dsh.profile.bundles`）；构建期安全扫描敏感文件（api_key/token/secret/password/credential/URL嵌入凭据/长token），发现则构建失败；排除 `.env`/`.local.*`/`.secrets*` 文件；非空断言（0 插件 + 0 presets 时构建失败）
  - 新增 `scripts/build-plugin-layer.ps1` 交互式编排脚本
  - 新增 `src/lib/plugin-deployer.js` 首次启动部署逻辑：幂等非破坏性部署到 `~/.dsh/profiles/web/`（node_modules + package.json 非破坏合并 dsh.profile.bundles），部署后写标记文件，用户后续修改不覆盖
  - `src/lib/dsh-resolve.js` 新增 `forceBundled` 参数，插件版强制使用内置 dsh 运行时
  - `src/lib/runtime-updater.js` 支持 `DSH_DESKTOP_OFFLINE=1` 跳过更新检查
  - `src/main.js` 插件版启动流程：检测 `resources/plugins/manifest.json` → 注入离线开关 → 跳过系统 dsh 检测 → 部署插件层 → 启动内置 dsh
  - 新增 32 个单元测试（dsh-resolve-plugins 4 + plugin-deployer 12 + snapshot-plugin-layer 16），全部通过

### 约束
- 插件版不打包模型配置/密钥（settings.yaml、.credentials.yaml 等一律排除）
- 插件版默认离线运行，不联网检查 dsh 内核更新
- 插件版强制使用内置 dsh，不使用系统已安装的 dsh


## 0.1.7 (2026-08-19)


## 0.1.6 (2026-08-19)

### 变更
- 项目更名为 **DSH My Simple Desktop**
- 更新应用图标：鲸鱼戴眼镜 + 左侧电脑屏幕，与官方图标区分
- README 重写：如实描述为简单封装壳，不夸大功能
- **内置 dsh 自动更新机制** — 每次启动时静默检查 npm registry 上 @deepseek-ai/dsh 是否有新版本，有则后台下载并更新到用户目录，享受最新 dsh 功能而不必升级桌面安装包
- **更新不阻塞启动** — 网络不可用或更新失败时静默跳过，不影响正常启动；每天最多检查一次
- **用户独立 dsh 运行环境** — 内置 dsh 首次启动时部署到 `%APPDATA%\dsh-desktop\runtime\dsh\`，后续更新在此目录独立进行

### 技术
- `src/lib/runtime-updater.js` — 新增模块：deploy、版本检查、下载解压、锁机制、回滚
- `resolveDshCommand` 新增优先级层：userData runtime > resources 内置 > 系统 PATH

## 0.1.5 (2026-08-19)

### 优化
- **每次启动优先使用系统 DSH** — 应用启动时先检测系统是否安装了 dsh，有则优先使用系统版本（用户自己安装或更新的），享受最新功能
- **回退机制** — 如果系统 DSH 启动失败（如版本不兼容），自动回退到安装包内置的 DSH 引擎，不影响使用
- **`resolveDshCommand` 新增 `preferSystem` 参数** — 系统 PATH 的 dsh 优先级高于内置 dsh

## 0.1.4 (2026-08-19)

### 修复
- **教程浮动按钮挡住 Session log 下载按钮** — 从右上角移到右下角，避免遮挡原有功能按钮

## 0.1.3 (2026-08-19)

### 新增
- **主窗口浮动「📖 教程」按钮** — 启动后主窗口右上角显示半透明教程按钮，点击即打开模型配置教程，无需进入设置窗口
- **Splash 窗口延长展示** — 启动完成后仍显示 1.5 秒完成状态，避免一闪而过看不清

### 修复
- 用户反馈 splash 一闪而过、找不到教程入口 → 按钮移到主窗口可见位置 + splash 延长显示

## 0.1.2 (2026-08-18)

### 变更

- 模型配置教程页面、设置窗口入口、README 对比章节

## 0.1.1 (2026-08-18)

### 新增
- **启动引导窗口** — 应用首次启动时弹出 splash 页面，依次展示启动步骤（检测 DSH 环境、启动引擎、就绪），避免用户以为程序卡死
- **环境检测** — 启动时自动检测系统是否已安装 DSH；有则直接使用系统 DSH，无则使用安装包内置的 DSH 引擎
- **内置 DSH 运行时** — 安装包包含完整的 DSH 引擎（node.exe + 全部依赖），同事无需提前安装 DSH 即可使用，也无需联网下载

### 修复
- **同事无 DSH 环境启动崩溃** — 之前用户必须自行安装 `dsh` 才能运行；现在安装包自带，即装即用
- **安装包体积大导致安装慢** — 安装时 NSIS 详情面板显示文件复制进度，用户可看到"正在部署 DSH 引擎"的步骤

### 技术
- `src/splash/splash.html` — 启动引导页面（暗色/浅色主题、旋转动画、进度条）
- `src/preload.js` — 新增 `electronAPI.onSplashProgress` IPC
- `src/main.js` — 新增 splash 窗口管理、环境检测、分步状态推送
- `CHANGELOG.md` — 建立更新日志
- `scripts/bump-version.js` — 一键升级版本号 + 记录日志 + 打包
