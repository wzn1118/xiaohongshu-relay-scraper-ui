# 内置 Codex 版启动说明

这个独立解压包包含项目的“内置 Codex Runtime”模型接入、Codex 工作台源码和与文件名目标一致的原生 Codex app-server，不包含用户密钥、登录态或本机数据。

## Windows

Windows x64 包完整解压后双击 `Start-Codex-App.cmd`。

## macOS

Apple Silicon 必须选择文件名含 `macos-arm64` 的包，Intel 必须选择 `macos-x64` 的包。完整解压后在 Finder 中双击 `Start-Codex-App.command`。首次运行会安装应用依赖并构建前端，但 Codex native runtime 已包含在包内。

包内 `runtime/codex/codex-runtime-manifest.json` 只记录目标平台、架构、相对入口、来源包版本和 SHA-256。发布工作流会在匹配架构的 runner 上验证二进制格式、启动入口、`/api/health`、Codex status、`thread/list` 和 `/codex/` 页面后才允许上传。

启动后，在 AI 服务中选择“内置 Codex Runtime”，填写模型服务 Base URL、访问密钥和模型即可验证连接。推理凭据只写入解压目录的本机配置，不进入 GitHub 发布包。
