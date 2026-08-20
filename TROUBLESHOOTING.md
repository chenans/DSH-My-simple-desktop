# DSH Desktop 启动失败诊断指南

## 问题现象

后端同事在 Win11 23H2 上安装完整版后，启动报错：
```
DSH 服务启动失败。
dsh 服务在90s 内未就绪(端口 3080):connect ECONNREFUSED 127.0.0.1:3080
```

前端同事同版本安装包可正常启动。

## 诊断步骤（请后端同事按顺序执行）

### 步骤 1：获取日志文件（最关键）

日志文件路径：
```
%APPDATA%\dsh-my-simple-desktop\logs\main.log
```

打开方式：按 `Win+R`，粘贴上面的路径，回车。

将 `main.log` 文件发回来。日志中会包含：
- `[dsh-err]` 前缀的行 — dsh 进程的 stderr 输出（崩溃原因）
- `dsh exited (code=..., signal=...)` — dsh 进程退出信息
- `dsh crashed ... restart N/5` — 重启记录
- `[runtime-updater]` 前缀的行 — 运行时部署情况

### 步骤 2：检查运行时部署目录

打开文件资源管理器，检查以下目录是否存在：

```
%USERPROFILE%\.dsh-desktop\
```

应该包含：
- `node.exe`（约 87MB）
- `node_modules\` 文件夹
- `.version` 文件
- `dsh.cmd` 文件

如果目录不存在或不完整，说明部署失败。

### 步骤 3：检查 DSH 数据目录

```
%USERPROFILE%\.dsh\
```

应该包含 `profiles\web\` 子目录。

### 步骤 4：检查是否有残留的系统 dsh

打开命令提示符（cmd），运行：
```cmd
where dsh.cmd
```

- 如果输出路径（如 `C:\Users\xxx\.dsh-desktop\dsh.cmd`），说明 PATH 中有 dsh
- 如果输出 `C:\Program Files\nodejs\dsh.cmd` 或其他 npm 全局路径，说明曾通过 npm 安装过 dsh，**这可能导致应用优先使用系统 dsh 而非内置版本**

### 步骤 5：命令行手动启动 dsh（定位崩溃原因）

打开命令提示符（cmd），依次运行：

```cmd
cd %USERPROFILE%\.dsh-desktop

set DSH_HOME=%USERPROFILE%\.dsh

node.exe node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --port 3099
```

观察输出：
- 如果报错，把完整错误信息发回来
- 如果成功输出 `dsh web: http://127.0.0.1:3099`，说明 dsh 本身没问题，问题在 Electron 集成层

### 步骤 6：检查杀毒软件/Windows Defender

检查 Windows Defender 安全中心 → 保护历史记录，看是否有：
- 阻止 `node.exe` 运行
- 阻止文件复制（部署阶段）
- 检测到可疑行为

如果有第三方杀毒软件（360、火绒等），也检查其隔离/拦截记录。

### 步骤 7：用命令行启动 Electron 应用并捕获输出

打开命令提示符（cmd），运行：

```cmd
cd "C:\Users\你的用户名\AppData\Local\Programs\dsh-my-simple-desktop"

"DSH My Simple Desktop.exe" --enable-logging=stderr --v=1 2>stderr.log
```

等待报错后，把 `stderr.log` 发回来。

## 最可能的原因（按概率排序）

1. **杀毒软件拦截**：Defender 或第三方杀软锁定新复制的 `node.exe`（87MB），导致 dsh 进程启动即被杀
2. **部署不完整**：`copyDirSync` 复制 33000+ 文件时部分失败（杀软锁定），dsh 启动时找不到依赖
3. **系统 dsh 残留**：PATH 中有旧版 dsh，应用优先使用系统 dsh 但该版本有问题
4. **junction 创建失败**：`healProfilesModuleFallback` 创建符号链接被杀软阻止
5. **SmartScreen 静默阻止**：未签名 exe 被 SmartScreen 拦截

## 临时解决方案（如果急需使用）

如果诊断步骤 5 成功（dsh 能独立启动），可以：

1. 先用命令行手动启动 dsh：
   ```cmd
   cd %USERPROFILE%\.dsh-desktop
   set DSH_HOME=%USERPROFILE%\.dsh
   node.exe node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --port 3080
   ```

2. 然后用环境变量启动桌面应用：
   ```cmd
   set DSH_DESKTOP_URL=http://127.0.0.1:3080
   "C:\Users\你的用户名\AppData\Local\Programs\dsh-my-simple-desktop\DSH My Simple Desktop.exe"
   ```
