# Hermes Admin 与官方 Desktop 浏览器适配

日期：2026-10-16。状态：独立开发预览已完成；NAS 双入口宿主（app/server/nas-admin-host.js）已于 2026-10-17 接入 monitor.js 运行时（feature/dual-entry 分支），2026-10-17 起桌面已移除经典控制台入口（app/ui/config 仅保留 hermes-agent.admin / hermes-agent.desk 双入口），经典网页路径 /app/hermes-agent 仍在 monitor.js 上作为回退服务，不构成桌面入口。

## 实现位置与运行边界

- `frontend/admin/`：Vue 3、TypeScript、Naive UI、Pinia 管理前端，参考 Harness Admin 的布局、配色与操作组织。
- `app/browser/bridge.js`：浏览器宿主能力，向官方渲染器提供连接、API、文件和浏览器操作。通过宿主代理访问同一套原生配置和数据库。
- `app/server/browser-host.mjs`：独立本机预览宿主，监听 `127.0.0.1`，管理自己启动的 `hermes serve`，提供 HTTP/WebSocket 代理及真实状态。
- `scripts/build-browser.mjs`：将固定核心的 Desktop/Shared 复制到 `.build/browser-core/`，按官方锁文件安装构建依赖，注入浏览器入口后编译到 `app/work-ui/`。
- `scripts/check-browser.mjs`：使用真实 Hermes 后端、真实桌面渲染器和本地测试模型进行浏览器验证；不调用付费模型。

`app/hermes-src/` 中的固定官方源码未因本轮适配而修改。浏览器桥作为普通脚本在官方模块之前执行，避免共享模块初始化早于桥接安装。
构建目录、生成页面与测试数据均不入库；官方提交仍由 `config/bootstrap/hermes-source.json` 标识。

默认开发入口：

- Admin：`http://127.0.0.1:18765/app/hermes-agent/next/`
- Hermes：`http://127.0.0.1:18765/app/hermes-agent/next/web/`

预览使用 `.build/browser-home/`，同时隔离子进程的 HOME/USERPROFILE 和运行时目录。
此宿主只供本机开发验证，不能直接当作 NAS 的访问鉴权方案；生产接入需要沿用飞牛入口权限并验证独立访问认证。

## 当前可操作范围

| 页面/能力 | 开发预览实现 | 待完成 |
| --- | --- | --- |
| 概览 | 实际启动、停止、重启工作服务；原生健康状态；版本、Commit、Build；完整 FPK 更新检查与下载入口 | 通讯 Gateway 生命周期、资源采样、fnOS 应用中心一键安装联调 |
| 工作区 | 按明确 profile 调用原生 `projects.tree`，目录定位/普通浏览器复制路径 | NAS FileManager 实机验证；更多原生时间字段 |
| 模型 | 45 家原生预设供应商搜索与配置；推荐默认模型；自定义接口新增、编辑、删除、验证、模型发现与设为默认；OAuth 状态与退出 | 浏览器内 OAuth 登录启动和轮询、真实供应商联调、辅助模型 |
| 工具 | 原生工具集与技能读取、启停；原生插件 hub 列表 | 技能安装/更新/内容管理、插件管理与授权 |
| MCP | 服务列表、HTTP/stdio 新增、启停、测试、移除 | 编辑、凭据配置、OAuth |
| 通讯 | 动态原生平台目录、字段配置、启停和平台测试；Telegram、WhatsApp 使用原生配对接口；Feishu / Lark 复用 0.22.2 原生 device-code 流程，扫码后自动创建机器人并以服务端会话保存凭据 | Telegram、WhatsApp、Feishu / Lark 的真机消息闭环验证 |
| 定时任务 | 原生任务列表、新建（默认暂停）、修改、暂停/恢复 | 立即执行、执行历史和会话跳转、投递目标 |
| 日志 | 直接使用 0.22.2 原生 `/api/logs` 的来源、最低级别、组件前缀和 Profile 作用域；另含宿主/服务进程输出、关键词筛选、实时刷新与下载 | 日志轮转与完整诊断脱敏策略 |
| 应用设置 | profile 选择、创建和删除，SOUL 编辑；原始 `config.yaml` 路径与编辑入口；按 0.22.2 原生 schema 生成折叠高级设置；保存后明确提示重启 | Profile 导入导出、宿主运行/网络设置、备份恢复与诊断 |
| 官方工作界面 | 直接编译官方 React 渲染器，以 HTTP/JSON-RPC 连接原生后端 | 逐项完成以下浏览器能力验收 |

原生设置页只根据当前核心返回的 schema 与值生成控件，不根据猜测添加开关。
配置加载失败时不允许保存；仅发送修改字段；异步结果按请求代次与 profile 处理。
专用的工具、MCP、通讯、定时任务和 profile 管理路由引导至 Admin，保留原生聊天和会话操作。官方综合设置页中全局配置与工作界面偏好的拆分仍须继续处理。

产品入口固定为 Hermes Admin 和官方 Desktop 工作界面。当前方案不增加 Dashboard 页面、开关或入口。

## 浏览器能力与数据边界

- 后端令牌保存在宿主进程，浏览器连接描述中的 token 为空。浏览器使用 HttpOnly、SameSite Cookie；HTTP 和 WebSocket 均校验 Host、Origin 与会话。
- HTTP/WS 代理保留子路径及作用域，真实令牌由宿主补入；不向原生服务传递浏览器 Cookie 或调用方提供的上游认证信息。
- profile 选择由请求作用域承担，不调用全局 `/api/profiles/active` 完成浏览器切换。项目列表使用原生 `projects.tree` 的作用域，避免误用聚合所有 profile 的 REST 项目树。
- NAS 文件读取与下载由原生文件接口执行。客户端选择/拖入的文件先缓存到浏览器 IndexedDB，经原生附件协议上传；单个本机文件暂限 25 MB。浏览器未发送的附件缓存清理策略仍需完善。
- 浏览器窗口/下载与系统文件管理分别处理。Electron 专用的系统热键、托盘、更新、嵌入式 webview、截图、终端等不能仅凭页面存在就认定已支持。
- 停止工作服务后 Admin 保持可用；读取依赖后端的数据返回明确错误。预览宿主不会接管或停止端口上已有的其他进程，也不自动重启手动停止的后端。

## 构建与验证

在主项目目录使用与固定核心兼容的 Node（本机已使用 26.7.0）及包含 Hermes 依赖的 Python 环境。

```powershell
node scripts/build-browser.mjs
Set-Location frontend/admin
npm ci
npm run build
Set-Location ../..
node --test tests/browser-host.test.mjs
node scripts/check-browser.mjs --python <Hermes环境的python.exe>
node app/server/browser-host.mjs --config .build/browser-preview.json
```

预览配置 JSON 可提供 `python`、`port`、`backendPort`、`dataRoot`。不需要在配置文件填写后端令牌；宿主会生成进程内随机值。
浏览器端到端脚本需要先构建两个前端，并使用本机 Microsoft Edge 的无头模式；报告与截图保存到独立的 `.build/browser-e2e-*/`。
测试结果以对应目录的 `report.json` 为准，不把成功编译等同于全部能力已通过验收。

### 本轮验证结果

- Admin TypeScript 检查、Vite 构建与官方 Desktop 浏览器构建通过。
- `node --test tests/browser-host.test.mjs`：4 项通过，覆盖 HTTP/WS 鉴权、后端凭据隔离、Profile 请求作用域、管理入口分流和停服错误反馈。
- 真实后端的浏览器端到端验证：13 项通过、0 项失败。验证流式对话、中止、刷新恢复会话、客户端文件拖入和原生附件上传、文件上传下载、Profile 配置隔离、高级设置部分保存、9 个 Admin 页面、同 Profile 管理跳转、移动端无横向溢出，以及手动停服后 Admin 可访问。
- 测试模型为本机 HTTP fixture，未调用付费模型；上述验证不等同于真实供应商、通讯平台或 NAS 文件管理器验收。
- 最后一次完整报告：`.build/browser-e2e-nzbWYF/report.json`。预览截图：`.build/admin-overview.png`、`.build/admin-settings.png`、`.build/admin-logs.png`、`.build/admin-messaging.png`、`.build/admin-feishu-qr.png`。

## 接入安装包前的门槛

1. 验证真实后端的对话流式输出、中止、重载恢复、附件、profile 及子路径代理。
2. 补齐首版技能管理、备份恢复及诊断，逐项完成持久化操作和失败反馈验证。
3. 将宿主能力接入 fnOS 的认证、目录权限、日志与进程管理，验证两个桌面图标和 NAS 上的 HTTP/WS。
   〔2026-10-17 已推进：`app/server/nas-admin-host.js` 接入 monitor.js 双监听（unix socket + 独立 TCP），/admin/* 静态与 api/host/* 就位，native 反代与 WS 复用 dashboard-proxy 机制（零新增进程）；桌面三入口已在 app/ui/config 登记；单测 + 真实 HTTP 冒烟通过（tests/nas-admin-host.test.mjs、tests/nas-admin-smoke.mjs）。余下：NAS 真机验证 + 旧页面下线评估（门槛 4）。〕
4. 对旧配置与会话执行备份/归档迁移，停用重复后台任务后替换旧页面；保留失败恢复路径。
5. 形成独立的新版本 FPK 并在 NAS 验证，当前已有的 0.21.150 安装包不因本机预览自动改变。

## NAS 双入口接入（2026-10-17，feature/dual-entry）

宿主：`app/server/nas-admin-host.js`（Web API 风格，monitor.js 在 handleCustomRoute 之前挂载）。

- **URL 布局**：`/admin/` → Hermes Admin（admin-ui）；`/admin/web/` → 桌面端工作台（work-ui）；
  `/admin/api/host/*` → 宿主 API；`/admin/api/native/*` → 复用 `proxyDashboard` 反代到
  `hermes dashboard`（127.0.0.1:9219，注入 DASHBOARD_SESSION_TOKEN）。两种 URL 形态兼容：
  门户 iframe（`/app/hermes-agent/admin/...`）与独立 TCP（`/admin/...`）。
- **关键决策**：native 后端复用 monitor 已管理的 dashboard 进程，**零新增进程**；
  `api/host/service/*` 映射到 `spawnHermes("dashboard")/stopPid(PID_DASHBOARD)`，
  网关生命周期仍由经典面板 `/api/start|stop` 管理。
- **WS**：`/admin/api/native/api/ws` 经 monitor 升级分支的 `dashboardProxyPrefixes`
  落入既有 dashboard-proxy 双工机制（文本帧转换/断线重连/keepalive），未改既有行为。
- **桌面入口**：`app/ui/config` 保留 hermes-agent.admin.Application（/admin/）与
  hermes-agent.desk.Application（/admin/web/）双入口；7c03447 已移除经典
  hermes-agent.Application（manifest 的 desktop_applaunchname 随之指向 admin 入口）。
- **凭据不变量**：渲染层注入的 token/ticket/internal 在反代前一律剔除，会话令牌只由宿主注入
  （tests/nas-admin-host.test.mjs 专测项）。
- **验证**：`node --test tests/nas-admin-host.test.mjs`（12 组断言）+
  `node tests/nas-admin-smoke.mjs`（12 项真实 HTTP 冒烟，含升级分支前缀匹配）全部通过；
  `node --check` monitor.js / nas-admin-host.js 语法通过；browser-host 既有 4 项测试无回归。
