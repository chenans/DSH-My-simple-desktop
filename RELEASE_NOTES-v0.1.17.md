## v0.1.17 — 关闭保护 + rc7 运行时 + 双轨安装包

### 新功能

- **关闭保护**：关闭窗口前检测大模型任务是否进行中，检测到则弹窗确认（"仍然关闭"/"取消"），防止会话中断或数据丢失
  - 多重检测：发送按钮 `aria-label`（停止/stop/abort/cancel）+ SVG 图标形状（`<rect>` 停止 vs `<path>` 发送箭头）
  - 文案变了 SVG 兜底，图标变了文案兜底，都变了默认放行
- **内置 dsh 升级到 rc7**：更稳定，支持 `--no-open` 参数

### 修复

- `--no-open` 参数兼容性：只在系统 dsh 模式下添加，内置 dsh 不需要
- `cleanProfilesNodeModules()` 误删 scope 目录（`@xxx`）导致崩溃
- task-board ledger 锁冲突崩溃：启动时杀残留 dsh 进程 + 删除锁文件
- 非 symlink 的 `profiles/node_modules` 条目导致 dsh 启动崩溃

### 安装包

| 版本 | 文件 | 大小 | 适用 |
|------|------|------|------|
| 完整版 | `DSH My Simple Desktop-0.1.17-Setup.exe` | 151.8 MB | 无 dsh 环境，开箱即用 |
| 精简版 | `DSH My Simple Desktop-0.1.17-Lite-Setup.exe` | 81.5 MB | 已装 dsh，安装快 |

> 安装包未签名，Windows SmartScreen 会提示"不识别的发布者"，点击"更多信息 → 仍要运行"即可。

### CI 说明

CI（GitHub Actions）仅自动构建精简版。完整版因含内置 dsh 运行时（被 .gitignore 排除）需本地构建后手动上传。
