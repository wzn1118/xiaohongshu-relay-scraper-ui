# 便携版与 Playground 项目

## today-you-applied-portable

### 定位

这是主项目的 Windows 10/11 x64 便携交付快照，不宜包装成完全独立产品。它适合回答“如何把开发项目交给非技术用户使用”。

### 当前证据

- 本地目录没有 remote 和 commit，约 394 个未跟踪项。
- package 使用 React 19、Vite、TypeScript、Node MJS、Python 和 Playwright。
- 根目录包含 start-windows.cmd、start-linux-macos.sh 和一键启动入口。
- README 描述捆绑 Node、Python、浏览器/runtime、首次登录、模型 provider、SMTP/Outlook 和 Data Copilot。

### 产品化故事

1. 将 Node/Python/浏览器依赖封装到便携目录。
2. 首次启动检查端口、runtime、环境模板和健康端点。
3. 用户通过引导完成浏览器登录、模型和 SMTP 配置。
4. 发布包排除账号、Cookie、key、邮件和任务数据。
5. 验证脚本在全新目录执行安装、构建、启动和健康检查。

### README 数据量边界

README 中的 715 岗位记录、197 帖子、4,062 评论、1,495 用户属于包内数据快照描述。它们不是用户增长、采集吞吐或当前主仓库数据量。

## Playground/feishu-openai-bot

### 定位

一个 FastAPI + 飞书 Events + OpenAI Responses API + SQLite 的消息机器人原型。

### 入口与运行

- app/main.py
- uvicorn app.main:app --port 8000 --reload

### 可讲点

- 事件回调、消息幂等和异步模型调用。
- SQLite 会话状态。
- 飞书消息与 Responses API 的格式转换。
- 小型服务从 webhook 到模型再到回复的完整链路。

### 待补

- webhook 签名和加密事件。
- 速率限制、消息去重、重试和观测。
- Git 历史与部署说明。

## Playground/secondary-brightness-widget

### 定位

PowerShell/WPF + DDC/CI 的 Windows 工具，用于控制第二显示器亮度。

### 可讲点

- 单实例进程。
- 显示器枚举与第二屏选择。
- DDC/CI 命令和错误处理。
- 开机启动、托盘/窗口交互。

### 面试价值

适合展示对 Windows 桌面、硬件边界和快速原型交付的理解。不要把它与主项目混成同一产品。

## Playground/xhs_scraper

### 定位

Python Relay 采集与 JSON/CSV/XLSX 整理的早期原型，可作为主项目演进证据。

### 演进讲法

早期目标是“把搜索结果导出”；后来发现登录态、安全验证、正文补全、重复项、失败恢复和证据链才是核心复杂度，因此逐步迁移到 JobManager、ledger、SSE 和 Data Copilot。

### 数据边界

输出目录可能含个人或抓取数据，展示前应使用脱敏 fixture，不直接发送原始文件。

## 项目组合用法

- 便携版回答部署、首次启动、依赖和运维。
- 飞书 bot 回答 webhook 和轻量 AI 集成。
- 亮度控件回答 Windows/hardware automation。
- xhs_scraper 回答产品演进与“为什么不再做一次性脚本”。
