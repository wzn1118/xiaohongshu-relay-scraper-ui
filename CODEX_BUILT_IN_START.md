# 内置 Codex 版启动说明

这个独立解压包包含项目的“内置 Codex Runtime”模型接入和 Codex 工作台源码，不包含用户密钥、登录态或本机数据。

## Windows

完整解压后双击 `Start-Codex-App.cmd`。

## macOS

完整解压后在 Finder 中双击 `Start-Codex-App.command`。首次运行会安装依赖并构建应用。

启动后，在 AI 服务中选择“内置 Codex Runtime”，填写模型服务 Base URL、访问密钥和模型即可验证连接。推理凭据只写入解压目录的本机配置，不进入 GitHub 发布包。
