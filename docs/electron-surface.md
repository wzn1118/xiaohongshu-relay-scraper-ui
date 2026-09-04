# Codex Renderer Electron API Surface

## 分析方法与边界

本报告分析 Desktop 26.803.81509 的实际 `preload.js` 与官方 Renderer assets。证据来自 `scripts/probe-codex-web-runtime.mjs` 生成的 `output/codex-web-runtime-probe/0.147.0-alpha.6.6/runtime-report.json`。

分析器不是字符串 grep：

1. 用 TypeScript AST 找到 `require("electron")`，不依赖接收变量名。
2. 从该符号追踪 `contextBridge`、`ipcRenderer` 与 `webUtils` property chain。
3. 读取 `exposeInMainWorld` 的 global name 和对象方法。
4. 对 Renderer 使用 TypeScript symbol checker 做作用域感知 alias 追踪，避免 minified 短变量在不同作用域碰撞。
5. 对静态计算的 dynamic channel 保留表达式占位，而不是猜测具体值。

静态分析仍不能发现按运行条件生成的 property、反射调用、worker 内部协议或从远端数据决定的 channel。因此最终 surface 应是 `Static Surface + Observed Runtime Surface` 的并集。

## Preload 暴露面

官方 preload 暴露两个 global：

```text
globalThis
├── codexWindowType
└── electronBridge
    ├── acknowledgeChunkedMessage
    ├── getAppSessionId
    ├── getBuildFlavor
    ├── getDesktopUserAgent
    ├── getFastModeRolloutMetrics
    ├── getInitialSidebarBootstrap
    ├── getPathForFile
    ├── getPreloadStartedAtMs
    ├── getSentryInitOptions
    ├── getSharedObjectSnapshotValue
    ├── getSystemThemeVariant
    ├── isDeviceCheckSupported
    ├── isIntelMacBuild
    ├── sendMessageFromView
    ├── sendWorkerMessageFromView
    ├── showContextMenu
    ├── startFileDrag
    ├── subscribeToSystemThemeVariant
    ├── subscribeToWorkerMessages
    ├── triggerSentryTestError
    ├── usesOwlAppShell
    └── windowType
```

此外读取 `process.platform`、`process.arch`。这些值属于 host metadata，不应让 Web Renderer 直接访问 Node `process`；shim 应显式提供归一化 platform capability。

## Electron 原语与 IPC channels

| Electron 原语 | 静态识别的 channel / 用途 |
| --- | --- |
| `contextBridge.exposeInMainWorld` | `codexWindowType`, `electronBridge` |
| `ipcRenderer.send` | `codex_desktop:chunked-message-ack` |
| `ipcRenderer.invoke` | message-from-view、context menu、fast-mode metrics、Sentry test、dynamic worker channel |
| `ipcRenderer.on` | message-for-view、system theme、MCP app sandbox host message、dynamic worker channel |
| `ipcRenderer.removeListener` | dynamic worker channel cleanup |
| `ipcRenderer.sendSync` | build flavor、initial sidebar、Sentry init、shared objects、theme、Owl flag、file drag |
| `ipcRenderer.postMessage` | `codex_desktop:connect-app-host`，携带 MessagePort |
| `webUtils.getPathForFile` | 从 Electron `File` 对象取得本地绝对路径 |

静态提取的明确 channels：

```text
codex_desktop:chunked-message-ack
codex_desktop:mcp-app-sandbox-host-message
codex_desktop:show-context-menu
codex_desktop:get-sentry-init-options
codex_desktop:get-build-flavor
codex_desktop:get-uses-owl-app-shell
codex_desktop:get-system-theme-variant
codex_desktop:get-initial-sidebar-bootstrap
codex_desktop:get-fast-mode-rollout-metrics
codex_desktop:system-theme-variant-updated
codex_desktop:trigger-sentry-test
codex_desktop:connect-app-host
codex_desktop:start-file-drag
codex_desktop:message-from-view
codex_desktop:message-for-view
codex_desktop:get-shared-object-snapshot
```

worker 的 send/subscribe channel 由函数动态生成，应在 runtime instrumentation 中补足。

## Renderer 实际引用

AST 在 14 个含 Desktop global 的 Renderer module 中发现 19 个实际调用方法：

```text
getAppSessionId
getBuildFlavor
getDesktopUserAgent
getInitialSidebarBootstrap
getPathForFile
getPreloadStartedAtMs
getSentryInitOptions
getSharedObjectSnapshotValue
getSystemThemeVariant
isDeviceCheckSupported
isIntelMacBuild
sendMessageFromView
sendWorkerMessageFromView
showContextMenu
startFileDrag
subscribeToSystemThemeVariant
subscribeToWorkerMessages
triggerSentryTestError
usesOwlAppShell
```

`acknowledgeChunkedMessage`、`getFastModeRolloutMetrics` 与 `windowType` 未在当前静态 call surface 中出现，不代表可立即删除：可能通过 property read、间接引用或条件 chunk 使用。自动 shim generator 应默认覆盖 preload 暴露面的全集，再按 runtime observation 标记热路径，而不是按一次静态扫描裁剪 API。

## 替代分类

分类定义：A = Browser API；B = Codex app-server；C = Local Host RPC；D = 当前 Web 核心不需要/no-op；E = 尚不能确认完整替代。

| Bridge 方法 | 当前用途 | 分类 | Web Runtime 处理 |
| --- | --- | --- | --- |
| `sendMessageFromView` | app-server 双向协议入口 | B | 由 App Server Adapter/WebSocket 承担 |
| `acknowledgeChunkedMessage` | Desktop IPC 分块确认 | B/D | Host RPC 有独立 ack/backpressure 后可移除 Desktop ack |
| `getSystemThemeVariant` | 当前主题 | A | `matchMedia(prefers-color-scheme)` |
| `subscribeToSystemThemeVariant` | 主题更新 | A | `MediaQueryList.change` |
| `showContextMenu` | native menu | A/C | 基础菜单用 DOM；OS 集成项走 allowlisted Host RPC |
| `getPathForFile` | Electron File -> 本机路径 | C | 浏览器 File 无可信绝对路径；上传句柄或 host picker token |
| `startFileDrag` | OS file drag | C/E | Host 创建临时 artifact/drag handle；Safari/跨窗口需单独验证 |
| `sendWorkerMessageFromView` | Desktop worker IPC | C/E | Web Worker/MessageChannel 可替代计算；host worker 需 typed RPC |
| `subscribeToWorkerMessages` | worker events | C/E | 同上，需提取动态 channel 和 payload schema |
| `getSharedObjectSnapshotValue` | host/config snapshots | B/C | Codex 语义数据走 adapter，设备/host 元数据走 Host RPC |
| `getInitialSidebarBootstrap` | 初始侧边栏快照 | B/C | 从 canonical thread/project store 构建；不保留 sendSync |
| `getFastModeRolloutMetrics` | Desktop rollout metrics | D | Web telemetry 自主管理；不阻断核心流程 |
| `getSentryInitOptions` | Desktop telemetry init | D | Web telemetry 配置，不伪装 Desktop IPC |
| `triggerSentryTestError` | 诊断 | D | Web 自有诊断入口 |
| `getDesktopUserAgent` | capability/telemetry | A/D | 标准 UA + runtime fingerprint，不冒充 Desktop |
| `getAppSessionId` | 会话关联 | A | Web crypto UUID/host session id |
| `getPreloadStartedAtMs` | 启动时序 | A | `performance.timeOrigin` |
| `getBuildFlavor` | feature gate | A/C | Runtime manifest/capabilities |
| `isDeviceCheckSupported` | native device capability | C/D | capability negotiation，未支持时显式 false |
| `isIntelMacBuild` | platform branch | A | normalized platform metadata |
| `usesOwlAppShell` | shell feature gate | D | Web runtime 固定 false，最终从 Renderer contract 移除 |
| `windowType` / `codexWindowType` | Desktop route gate | D/E | 目标是 `web`；当前 Renderer 是否接受需要 canary 验证 |

## 不应重复实现的能力

本版本 app-server schema 已提供 thread、turn、approval、model、MCP、skills、plugins、filesystem、process/PTY、config、account、remote control 等能力。Local Host 不应再造同一套 Codex domain service，只负责：

- app-server 发现、启动、停止、健康检查和协议适配；
- 受限文件 picker/handle 与用户授权的 workspace roots；
- OS clipboard、notification、open external 等可选集成；
- app-server 未覆盖的 Git/PTY/native bridge；
- loopback transport、origin/capability/session 安全；
- runtime discovery、fingerprint、known-good activation。

## Browser Shim 目标形态

短期 shim 为兼容官方 Renderer 可以继续暴露 `electronBridge`，但实现必须来自 capability table，不再伪装“所有 Desktop 服务都存在”。中期接口示例：

```ts
interface BrowserRuntimeCapabilities {
  runtimeKind: 'web';
  appServer: Set<string>;
  host: Set<'filePicker' | 'fileDrag' | 'clipboard' | 'notification' | 'openExternal'>;
  browser: Set<'theme' | 'worker' | 'indexedDb' | 'fileSystemAccess'>;
}

interface BrowserCodexBridge {
  request(message: unknown, signal?: AbortSignal): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
  capabilities(): BrowserRuntimeCapabilities;
}
```

官方 Renderer 兼容 facade 把上述稳定接口映射回当前 22 个 preload 方法；自有 Web Renderer 则直接依赖 canonical API，不再看到 Electron 名称。

## Runtime Instrumentation 设计

在非生产 canary 环境，bootstrap 应在官方 bundle 前安装记录 Proxy：

```js
globalThis.electronBridge = new Proxy(generatedShim, {
  get(target, property) {
    observe({ kind: 'get', property, at: performance.now() });
    const value = Reflect.get(target, property);
    if (typeof value !== 'function') return value;
    return (...args) => {
      observe({ kind: 'call', property, args: redactAndShape(args) });
      return value(...args);
    };
  },
});
```

记录限制：

- 参数只记类型、key、大小和脱敏摘要，不记录 prompt、token、文件正文或凭据。
- 记录调用时机、resolve/reject、返回 shape、event subscription 和 cleanup。
- 运行 P0 Playwright 流程后与 AST surface 合并。
- 新 property 默认为 unsupported，canary 失败，不在生产静默返回任意值。

## 自动 Preload Analyzer 输出契约

```json
{
  "globals": ["codexWindowType", "electronBridge"],
  "methods": {
    "sendMessageFromView": {
      "transport": "invoke",
      "channel": "codex_desktop:message-from-view",
      "dynamic": false
    }
  },
  "events": {
    "messageForView": {
      "transport": "on",
      "channel": "codex_desktop:message-for-view"
    }
  },
  "unresolved": []
}
```

Analyzer 必须按 AST symbol/declaration 识别 Electron binding，不能依赖变量名 `e`、`a` 或格式化文本；对动态 channel、computed property、MessagePort payload 标为 unresolved，并交给 instrumentation，不生成猜测性实现。

## 当前缺口

1. 尚未从 Electron main bundle 自动关联每个 channel 的 handler、参数 schema 和返回 schema。
2. 尚未对 worker 动态 channel 做运行时观测。
3. 尚未证明 `codexWindowType = "web"` 能让当前 Renderer 完整启动。
4. browser host 当前对 file path、file drag、worker、context menu 使用 no-op/降级，不能算完整 Desktop parity。
5. 尚未以第二个 Desktop/app-server 版本运行 surface diff；当前只能证明 analyzer 对本样本有效。

这些缺口都应进入 compatibility canary，而不是继续增加 minified string patch。

## Current native-surface implementation status

The current runtime evidence narrows this surface further:

- `showContextMenu` is implemented in the browser and returns the selected template id.
- `getPathForFile` intentionally returns `null`; browser file names are not treated as trusted local paths.
- `startFileDrag` remains an explicit unsupported synchronous operation and returns `false`.
- Dynamic worker IPC is implemented for the observed `git` worker through `host.worker.send`, with the original request/response/event envelopes and a Relay HTTP fallback.
- Dialog and clipboard are not methods in the current packaged preload surface. They remain optional future capabilities, not current bridge gaps.
- The Git compatibility worker confines actionable filesystem access to the active workspace and worktrees registered by that repository, validates typed methods, and returns structured errors for methods outside its current coverage. Read-only metadata probes for unrelated historical sidebar projects return `null` rather than widening the workspace boundary.
- The observed startup live queries for current/base/default branches and review summaries now complete through the browser bridge; branch diff statistics and submodule path prefetch are also implemented.
- Advanced read-only Git review is implemented with the packaged response shapes for `review-diff`, `review-patch`, `review-search`, and `commit-message-diff`, including untracked-file patches, search caps, and stale snapshot signaling.
- Review mutations are implemented for `apply-patch`, `apply-review-section-changes`, and `apply-changes`. The browser can apply or reverse file/hunk patches, stage or unstage review sections, revert selected sections, and transfer a source-tree diff into an allowed checkout. File revisions are checked again before section writes.
- Managed worktree mutations are implemented for `create-worktree`, `worktree-status`, `remove-worktree`, and `prune-worktrees`. The worker keeps worktree creation below the configured root, validates branch/ref and path inputs, and returns structured Git errors.

Worktree restore snapshots, thread handoff, repository overwrite, and OS-level file drag remain capability gaps. Context menu, Git metadata/status, advanced review, review patch mutations, and the core worktree lifecycle are no longer no-ops.
