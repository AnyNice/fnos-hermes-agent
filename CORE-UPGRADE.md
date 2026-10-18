# Hermes 核心升级与构建

当前应用包：`0.21.150`；官方核心：`0.22.2`。

## 官方来源

- 发布：https://github.com/NousResearch/hermes-agent/releases/tag/v0.22.2
- Tag：`v0.22.2`
- 提交：`d923a5eb487a17c0a68801bba9ef0f56c81040a8`
- 来源锁定文件：`config/bootstrap/hermes-source.json`
- 安装目标：`config/bootstrap/hermes-version.env`

官方说明 0.22.1 从错误提交构建，包含未发布的网关功能；0.22.2 撤回这些改动。原内置提交 `297552a9d646119871391d202509822cd86330df` 与此次稳定版存在较大代码差异，不能只按小版本差异评估升级。

与原内置提交比对后，本地核心没有业务源码补丁，仅 npm 锁文件有修改；飞牛定制继续由外层 Monitor、控制台和配置模板承担。此次没有修改官方 Python/TypeScript 源码。

## 构建

前置条件：Git、Python 3.14、Node 26.7.0（本次使用的官方 PM 锁定版本）、npm、官方 fnpack 1.2.3。
Windows 下其他 Node 版本曾导致 Web 构建原生进程崩溃；本次 Node 26.7.0 构建通过。

在项目根目录执行，`python` 需要指向 Python 3.14：

```sh
python scripts/prepare-hermes.py
```

脚本检查官方 tag 与完整提交，导出干净源码、生成真实版本标记，再替换 `app/hermes-src`。
原目录完整保留到 `.build/backups/hermes-src-<时间>-<编号>`，不会混合新旧版本已删除的模块。
可以通过 `--checkout /path/to/official-checkout` 重用已经下载且没有源码修改的官方仓库。

```sh
cd app/hermes-src
node scripts/build/node-deps.mjs --source . --workspace web --workspace ui-tui
npm run build --workspace web
npm run build --workspace ui-tui
cd ../..
python scripts/package-fpk.py --fnpack /absolute/path/to/fnpack
```

产物：`pkg/fnos-hermes-agent_v0.21.150.fpk`。`build-slim.sh` 也可调用同一打包脚本。
打包脚本检查核心提交、核心版本、安装目标版本及 Web/TUI 产物，排除依赖缓存、开发目录和环境密钥文件，补齐两层 tar 中脚本/ELF 的 Linux 执行权限，并同步重新计算 manifest 中的 app.tgz 校验值。
`.build` 内的备份和准备过程不进入应用包。

GitHub Actions 现在会下载锁定的官方源码，再构建前端和 FPK，不再依赖被 `.gitignore` 排除的本地核心目录。

## 安装与数据

通过飞牛应用中心手动安装新 FPK，使用升级流程保留应用数据。测试前备份 NAS 上的 `$TRIM_PKGHOME/data` 与 `$TRIM_PKGVAR`，包括 SQLite 的一致性备份。

官方已知限制：在 0.22.1 网关下运行过的部分会话在 0.22.2 中无法删除。此次仅验证了旧核心创建的普通 API 会话可读取并追加消息，不能覆盖所有真实会话结构。需要在 NAS 上进一步验证历史会话、微信/QQ/飞书、语音与群聊工作流。

安装脚本使用独立的 `hermes-install.id` 记录成功依赖同步，避免将新源码的版本标记误当成“旧 venv 已安装完成”。镜像失败按退出码重试；旧 hermes 可执行文件存在时也不会掩盖失败。

控制台“检查核心更新”现在读取官方 GitHub 发布；核心更新由 FPK 管理，不再把重装相同源码显示为核心升级。Dashboard 启动使用预构建资源与 `--skip-build`。

## 本次验证（Windows，2026-10-16）

- 官方 Web 前端类型检查及生产构建通过；TUI bundle 构建通过。
- 第一轮官方核心回归：160 通过、7 跳过；第二轮：43 通过、1 跳过（含重复版本验证）。POSIX 专用测试未在 Windows 上运行。
- CLI `--version`、`gateway run --help`、`dashboard --help` 通过。
- 旧源码生成临时 SQLite 会话，新源码读取并追加消息通过。
- 官方版本查询模块 3 个行为测试通过。
- 安装脚本失败重试、成功凭据与依赖变更识别通过。
- 归档权限修复后 app.tgz 与 manifest 校验一致性的回归测试通过。
- FPK 本地构建与解包检查通过。尚未在 NAS 上安装或进行真实模型/消息平台端到端验证。

## 下一次升级

1. 核对官方稳定版发行说明，更新 `hermes-source.json` 中的 version/tag/完整 commit。
2. 同步 `hermes-version.env`，增加应用包 manifest 版本。
3. 执行来源准备、前端构建、相关回归、打包和 NAS 验证。
4. 留存旧 FPK 与数据备份；数据库经新核心使用后，回退代码不能替代数据恢复。
