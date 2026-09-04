# 更新日志


## 0.1.35 (2026-09-04)

### 变更

- 用量统计窗口改为自定义标题栏，菜单和窗口控制按钮整合到同一行

## 0.1.34 (2026-09-05)

### 修复
- **按时间分布图折线与柱状不一致** — 折线此前选用"会话数"（每时段 0~2 个），与柱状图的 Token 消耗趋势相反（会话最多的日子 Token 可能为 0，Token 最高的日子会话可能贴底），看起来两套数据对不上。改为优先叠加"调用次数"（与 Token 消耗直接正相关），仅当整个窗口无调用数据时才回退为会话数；图例随所选指标显示"调用次数 / 会话数"
- **"缓存写入"一直显示 0** — 根因是数据源（`dsh-usage/usage-ledger.json` 与会话 tokenUsage）的 `cacheWriteTokens` 字段恒为 0（dsh 引擎未记录缓存写入量，API 计费仅区分 cache hit/miss）。统计代码读取并无错误，故不再用误导性的 "0" 展示：总计卡片与模型/Provider 明细表在无缓存写入数据时显示"未记录"，悬停有说明提示

### 测试
- 全套 116 个测试通过；另以真实数据对 usage.html 渲染输出做了 DOM 级验证（折线数据点 y 坐标与柱状趋势对齐、缓存写入"未记录"文案生效）

## 0.1.33 (2026-09-04)

### 修复
- **下载到最后突然弹"下载失败"错误窗** — 根因是 `downloadInstaller` 未返回下载结果（`downloadFile` resolve 无值），`destPath`/`assetName` 拿到 `undefined`，下载完成后 `spawn(undefined)` 抛异常触发错误弹窗。现正确返回 `{ destPath, assetName }` 并校验文件存在且非空
- **慢速网络（约 100KB/s）下下载容易中断且从头重下** — 三处加固：
  - 空闲超时由 120 秒放宽至 300 秒，302 重定向后的请求也挂超时处理
  - **断点续传**：中断后重试从已下载字节继续（Range 请求），不再从头下载；服务器不支持 Range（返回 200）时自动回退整包重下
  - 下载完成后按 Content-Length 校验文件大小，防止"下载完成但文件不完整"
- **下载失败重试时 Windows 报 EBUSY 文件占用** — 关闭文件流改为等待 OS 真正释放句柄后再重试（此前立即重开同一部分文件会报 "resource busy or locked"）

### 改进
- **下载进度收敛到系统托盘** — 移除独立下载弹窗。下载中点击托盘图标即可反复查看进度：实时百分比、已下载/总大小、当前速度（MB/s 或 KB/s）、重试状态；下载完成托盘菜单出现「安装更新并重启」，失败时显示错误并可直接「重试下载」
- 下载进行中再次触发下载会被忽略（防并发）

### 测试
- `test/update-checker.test.js` 新增 3 个下载用例（本地 HTTP 服务器模拟）：返回值对象 + 文件落盘校验、断点续传（中断后 Range 续传）、重试耗尽后拒绝并清理。全套 116 个测试通过

## 0.1.32 (2026-09-04)

### 修复
- **更新下载选错版本（下载 278MB 插件版而非精简版）** — 已安装应用「检查更新」时曾按 GitHub 资产名字母序挑选安装包，导致精简版用户误下载体积最大的 Plugins 版（278MB）。现改为**按当前安装版本匹配**：检测运行中的版本类型（精简版 / 完整版 / 插件版），下载对应体积的安装包（精简版→81MB 精简版安装包）；无法识别版本时回退完整版优先

### 测试
- `test/update-checker.test.js` 扩充至 9 个用例：新增精简版/完整版/插件版按版本匹配、未知版本回退、`detectCurrentEdition` 空安全。全套 113 个测试通过

## 0.1.31 (2026-09-04)

### 修复
- **总会话数 / 总交互轮次 / 总操作步数恒为 0** — 用量统计此前只读 `session_projcache.json` 汇总快照（仅含最近一个空白会话）。现改为读取 `storages/session_projcache/sessions/*.json` 每个会话的完整数据，并与汇总文件合并去重
- **时间范围选「最近 7 天 / 30 天」等查不到数据** — 日期过滤曾要求整天完整落在范围内，导致"今天"（range.end 非当日 23:59:59）与范围首日被剔除。改为区间重叠判断：只要当天与所选范围有交集即计入
- **时间分布图是横向倒置条形图** — 重写为垂直柱状图 + 折线叠加图（纯 SVG，无外部依赖）：柱形展示每时段总 Token，折线展示会话数（无会话数据时回退为调用次数），Y 轴刻度、图例、稀疏 X 轴标签齐全
- **时间粒度选择不生效** — `periodKey` 之前定义未使用，按天/周/月/年聚合实际未生效。现按所选粒度聚合，并生成连续时段序列（无数据时段补 0），图表不再跳空

### 新增
- **按工作区统计** — 通过 `workspace.json` 的 sessionIds 与会话 cwd 路径双重映射，按工作区聚合会话数、轮次、步数、Token、平均耗时与最后使用时间

### 测试
- 新增 `test/usage-stats.test.js`（5 个用例）：会话文件合并、范围过滤含当天、无范围全量、工作区聚合、周粒度分桶。全套 104 个测试通过

## 0.1.18 (2026-08-23)

### 修复
- **dsh 崩溃恢复逻辑全面修复** — 解决 6 个导致崩溃后无法正常重启的问题：
  - **崩溃重启不清理残留锁** — 抽取 `cleanupDshLocks()` 独立函数，重启前安全清理 `~/.dsh/task-board/ledger-v2.lock`（仅删 owner PID 已死的锁，不误删活进程锁），避免 dsh 抢不到锁导致崩溃循环
  - **`bootstrapDsh` 参数传错** — 重启路径误将超时数字当 `preferSystem` 传入，导致 `timeoutMs` 变 undefined。新增模块级变量 `dshPreferSystem` 缓存启动时解析值，重启时复用
  - **`dshRestarts` 计数器不重置** — 崩溃重启成功后不归零，逐渐耗尽重试预算。现重启成功后立即重置为 0
  - **`wmic` 已废弃** — Win11 23H2+ 移除 wmic，`killStaleDshProcesses` 静默失败。改用 PowerShell `Get-CimInstance Win32_Process` 替代
  - **崩溃后不杀残留进程树** — 崩溃 `exit` 事件中重启前调 `killDshTree()` + `cleanupDshLocks()`；`waitForHealthyUrl` 失败后 `killDshTree()` 兜底，避免端口冲突
  - **渲染进程崩溃只能重载一次** — `rendererReloaded` 置 true 后永不复位。`did-finish-load` 成功后复位为 false，后续崩溃均可自动重载


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
