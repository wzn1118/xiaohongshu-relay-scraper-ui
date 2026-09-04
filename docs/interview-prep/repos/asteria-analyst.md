# 一页项目卡：Asteria Analyst

## 定位

本地 Windows 企业数据分析、统计实验和管理报告工作台。

## 栈

Next.js 16、React 19、TypeScript、FastAPI/Pydantic、Pandas、DuckDB、Statsmodels、scikit-learn、ReportLab、PyPDF、python-docx。

## 主链

上传/画像 → AI 字段语义 → AI 业务路由 → AI 指标计划 → 确定性指标执行 → evidence validation → report binding → formal PDF release gate。

## 亮点

- AI 负责语义/规划，确定性代码负责数字。
- trace/schema/trace_id/derivation CSV 组成必需证据。
- 门禁失败只生成 debug 产物，并移除 management_report.pdf。
- CI 包含 Python/前端/Windows portable smoke/release。

## 数字等级

- 代码快照：362 个注册方法、81 个 live、18 个 family；70 个 pytest 文件。
- README 声明：4,028 method cards、273 runnable cards，本轮未重算。

## 边界

当前是本地单用户 workbench；浅克隆只有一个可达 commit，个人贡献需另补。

## 追问

- 为什么 362 个方法只有 81 live？
- AI 不可用时为什么只发 debug？
- 如何验证统计前提和数值容差？
