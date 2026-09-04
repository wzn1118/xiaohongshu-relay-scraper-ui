# 主仓库 CI 与 Release 精确事实

来源：当前 tracked 的 .github/workflows/ci.yml、release.yml，以及 package.json/scripts。审计时间 2026-08-18。

## Workflow 文件

| 文件                          | 名称    | 触发                                 | jobs                     |
| ----------------------------- | ------- | ------------------------------------ | ------------------------ |
| .github/workflows/ci.yml      | CI      | 任意 push、pull_request              | verify、browser、mailpit |
| .github/workflows/release.yml | Release | main push、v* tag、workflow_dispatch | one-click-windows        |

## CI / verify

- matrix OS：ubuntu-latest、windows-latest。
- actions/checkout：v4。
- Node：actions/setup-node@v4，版本 22，npm cache。
- Python：actions/setup-python@v5，版本 3.13，pip cache。
- 安装：npm ci。
- Python 安装：python -m pip install -r requirements.txt。
- 项目检查：npm run check。
- 依赖审计：npm run audit:dependencies。

## CI / browser

- runner：ubuntu-latest。
- Node：22。
- 安装：npm ci。
- 浏览器：npx playwright install --with-deps chromium。
- E2E：npm run test:e2e。
- 失败时上传 test-results/playwright。
- artifact 名包含 GitHub run id 与 run attempt。
- retention-days：7。
- if-no-files-found：ignore。

## CI / mailpit

- runner：ubuntu-latest。
- service image：axllent/mailpit:v1.30.6。
- SMTP 映射：1025:1025。
- HTTP 映射：8025:8025。
- Node：22。
- 安装：npm ci。
- 测试：npm run test:mailpit。
- 环境变量：MAILPIT_SMTP_PORT=1025。
- 环境变量：MAILPIT_HTTP_URL=http://127.0.0.1:8025。

## Release 全局配置

- permissions.contents：write。
- concurrency group：release-[GitHub ref]。
- cancel-in-progress：false。
- job：one-click-windows。
- runner：windows-latest。
- timeout：45 分钟。
- checkout fetch-depth：0。
- Node：22。
- Python：3.13。

## Release 步骤

1. npm ci --no-audit --no-fund。
2. python -m pip install --disable-pip-version-check -r requirements.txt。
3. npm run build。
4. package-github-release.ps1 从 HEAD 创建 xiaohongshu-relay-scraper-ui-one-click-windows.zip。
5. 同时记录 archive 与 checksum 输出。
6. verify-github-release.ps1 在端口 65431 验证 clean archive 安装和 health。
7. upload-artifact@v4 上传 ZIP 与 SHA-256。
8. artifact 名包含 GitHub SHA。
9. if-no-files-found：error。
10. retention-days：30。
11. v* tag 时使用 GitHub CLI 查看已有 release。
12. 已有 release 使用 gh release upload --clobber。
13. 新 release 使用 gh release create --verify-tag --generate-notes --title。

## npm run check 的当前展开

1. npm run lint。
2. npm run format:check。
3. npm run typecheck。
4. npm run test。
5. npm run test:python。
6. npm run test:api。
7. npm run build:frontend。
8. npm run test:artifacts。
9. npm run test:credentials。

## 事实边界

- Workflow 定义证明 CI 契约存在，不证明最近一次远端 run 成功。
- 本轮没有读取 GitHub Actions run 状态，也没有执行 npm run check。
- 当前工作树修改不会进入基于 HEAD/tag 的 release，除非先形成提交。
- 历史 acceptance report 的测试数字另行标记为 dated report。
