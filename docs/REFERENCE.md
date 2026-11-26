# 参考

> 类型：参考。记录可查的表和符号入口；规则本身在设计专题，当前实现与差距见 [11](architecture/11-实现与验收.md)。

先按这张表判断去哪查，再往下翻具体表格。字段和签名以源码为准；本页只回答“它在哪、叫什么、边界是什么”。

| 要查 | 去哪 |
|---|---|
| 一个类型或入口在哪 | 本页「符号速查」 |
| 一个错误码是什么意思 | 本页「错误码」 |
| `$DSH_HOME` 下有什么文件、坏了会怎样 | 本页「宿主状态文件」 |
| 命令与流程 | [上手](START.md)、[操作手册](DEVELOPMENT.md) |
| 模块职责与依赖方向 | [架构总览 §2.1](ARCHITECTURE.md#21-模块与依赖方向) |
| 当前行为与缺口 | [实现细节与验收](architecture/11-实现与验收.md) |

## 符号速查

| 符号 | 定义位置 | 一句话 |
|---|---|---|
| `AppDeclaration` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 一个应用：身份、操作、事件、对象类型、数据、能力与生命周期钩子 |
| `OperationDeclaration` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 一个操作：参数与结果 Schema、读写语义、开放设置、执行函数 |
| `defineOperation` | [runtime/src/define.ts](../packages/application/runtime/src/define.ts) | 声明操作，并让参数与返回值类型来自同一份 Schema |
| `AppContext` / `OperationContext` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 应用级与调用级上下文：能力门、取消信号、任务、事件与委托；store 由 `mountApplication` 工厂注入 |
| `CallOutcome` / `OutcomeError` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 统一调用结果：成功带 `result`，其余状态带 `error` |
| `TaskHandle` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 后台任务句柄：`taskId` 与 `done`；状态、进度与归属见 `TaskSnapshot`，取消结果见 `TaskCancelResult` |
| `ProcessDeclaration` / `ProcessAccess` | [runtime/src/types.ts](../packages/application/runtime/src/types.ts) | 应用声明的进程命令清单与应用侧 `ctx.process.run` 入口 |
| `GatedStore` | [store/src/gated.ts](../packages/application/store/src/gated.ts) | 按应用绑定、每次使用都检查 `storage` 能力的存储接口 |
| `mountApplication` | [runtime/src/index.ts](../packages/application/runtime/src/index.ts) | 把声明绑定到插件生命周期：启动、停止与注销 |
| `ApplicationRuntime` | [runtime/src/runtime.ts](../packages/application/runtime/src/runtime.ts) | 注册、调用、权限判定、生命周期与任务的运行时 |
| `ApplicationViewProps` | [client/applications/src/client/contract.ts](../packages/client/applications/src/client/contract.ts) | 页面拿到的调用、取消、订阅、导航、草稿与界面状态 |
| `ApplicationBridge` | [host-bridge/src/index.ts](../packages/application/host-bridge/src/index.ts) | 宿主侧服务：通信、授权与历史持久化、数据管理 |

符号快照在 [api-snapshot.json](../scripts/api-snapshot.json)，用于检查接口变化，不代替本表。新增或重命名公开符号时同步本表。

## 错误码

调用方按稳定的 `error.code` 分支，不解析 `error.message`。`platform.` 前缀表示平台产生的码；`app.` 前缀通常是应用自己的业务结果，也用于框架在能力、任务、委托和事件入口产生的失败结果（见下表）。可访问 `error.details` 时按需读取。

| 类别 | 调用结果里的错误码 |
|---|---|
| 目标与操作 | `platform.unknown-app`、`platform.unknown-op`、`platform.invalid-args`、`platform.not-open-to-caller`、`platform.denied`、`platform.confirmation-unavailable`、`platform.stopping`、`platform.unavailable` |
| 调用链 | `platform.call-cycle`、`platform.call-depth` |
| 终止 | `platform.cancelled`、`platform.execution-failed`、`platform.invalid-result` |
| 页面与草稿 | `platform.page-unavailable`、`platform.stale-snapshot`、`platform.action-not-allowed`、`platform.draft-not-shared`、`platform.draft-scope`、`platform.draft-conflict`、`platform.draft-invalid` |
| 页面调用边界 | `platform.cross-app-page`（客户端 shell 拒绝，不进入宿主） |
| 对象引用 | `platform.object-invalid-ref`、`platform.object-unknown-app`、`platform.object-unknown-type`、`platform.object-invalid-resolution`（解析失败以 `{ ok: false, error }` 返回，不是一次 `Outcome`） |
| 模型入口 | `platform.model-unavailable`、`platform.model-failed`、`platform.model-invalid-output`、`platform.model-limit-exceeded`（模型端口抛出的稳定错误，见[平台能力](architecture/5-平台能力.md#平台统一模型接口)） |
| 框架产生的 `app.*` 码 | `app.authorization-unavailable`（宿主授权端口故障）、`app.capability-not-approved`、`app.capability-undeclared`、`app.task-invalid`、`app.task-limit`、`app.task-request-conflict`、`app.delegation-invalid`、`app.delegation-unknown`、`app.delegation-unavailable`、`app.event-unknown-app`、`app.event-undeclared`、`app.event-ref-invalid`、`app.invalid-args`（进程命令校验） |

工具表面在参数/范围不合法时抛出 `HarnessError`，这些是工具异常码，不是 `Outcome.error.code`，不要与上表混用：

| 工具 | 当前异常码 |
|---|---|
| `applications` | `applications/invalid-action`、`applications/invalid-input`、`applications/unavailable`、`applications/not-in-scope` |
| `pages` | `pages/unavailable`、`pages/invalid-action`、`pages/invalid-input`、`pages/stale-snapshot` |
| `drafts` | `drafts/unavailable`、`drafts/invalid-action`、`drafts/invalid-input` |
| `delegation_report` | `delegation/unavailable`、`delegation/invalid-report` |

对象引用组件自身使用 `platform.object-mismatch`/`platform.object-unavailable` 作为本地解析状态，不写入 `Outcome.error.code`。

模型入口的四个码由模型端口抛出；应用应捕获并转换为自己的业务结果，未捕获时运行时按 `platform.execution-failed` 报告。

公开的 `RejectionCode` 还包含 `caller-not-declared`、`confirmation-declined`，当前没有产生路径，调用方不要依赖。

生命周期原因只写入应用状态的 `reason`，不是 `error.code`，不要按错误码分支：

| reason | 当前含义 |
|---|---|
| `platform.start-failed` | 启动失败，应用回到停用且不可调用 |
| `platform.health-failed` | 健康检查返回 `unhealthy`，实例停止，`activation` 保持用户设置 |
| `platform.stop-incomplete` | 停止预算耗尽或清理未完成，`runtime=stopping` |
| `platform.updating` | 维护/更新窗口，运行实例保持 `ready + health=degraded` |
| `platform.unavailable` | 目标设计中的“平台无法加载或运行”；当前没有设置该 reason 的路径，不要依赖 |

应用业务错误统一为 `app.<code>`。本表列出框架产生的码，不穷举应用自定义业务码；自定义码由应用定义并在其声明或文档中说明。目标设计里出现过的 `invalid-input`、`unknown-operation`、`starting`、`updating`（作为拒绝码）、`connection-lost`、`call-chain-limit` 目前不是实际产生的码，实现稳定前不要依赖这些名字。`unknown` 状态当前也没有产生路径。

## 宿主状态文件

宿主状态保存在 `$DSH_HOME/application-harness/`，与应用业务数据分开；完整路径和归属以[部署声明](../packages/bundle/app-harness/deployment.yml)为准，这些状态不放浏览器存储。

| 文件 | 用途 | 读取失败时 |
|---|---|---|
| `grants.json` | 长期能力与事件授权；旧版 operation grant 视为损坏，整表拒绝 | 拒绝使用无法确认的授权 |
| `policies.json` | 用户操作策略 | 按无法确认策略处理，不覆盖原文件 |
| `activation.json` | 用户启用状态 | 损坏时报告故障、保持所有应用停用（失败关闭）并保留原文件；应用区显示全局提示，修复文件后重启或在应用区显式启用（显式写入即修复）恢复 |
| `app-conversation.json` | 应用区会话绑定 | 报告故障，按无绑定处理 |
| `development.json` | 开发会话绑定 | 报告故障，按无绑定处理 |
| `onboarding.json` | 首次授权提示是否已展示 | 可再次显示提示，不改变授权；损坏时保存失败，需修复原文件 |
| `model-selections.json` | 每应用固定模型 | 报告故障，回退平台默认路由 |
| `model-limits.json` | 应用模型限额 | 报告故障，按默认限额处理 |
| `model-usage.json` | 模型用量统计 | 报告故障，不阻断业务 |
| `history.jsonl` | 基本调用历史 | 报告故障，业务调用继续 |
| `tasks.jsonl` | 后台任务控制面投影 | 报告故障；已中断的任务不自动重放 |
| `delegations.json` | 委托对象（pending/active/needs-person/ended） | 报告故障；损坏文件失败关闭，不重发 |
| `app-data.sqlite` | 统一业务数据 | 失败关闭，不能当空库覆盖 |
| `notes/attachments/` | 笔记应用自有附件字节 | 由应用自身处理；整库备份不含字节，附件备份走笔记导出 |

表内除 `app-data.sqlite` 与 `notes/attachments/` 外，都是宿主状态或控制面。业务数据和授予/委托/模型路由等状态读取失败关闭：文件不存在按首次运行处理，存在但读不懂时保留原文件，后续保存必须失败；activation、development 和 conversation 的显式修复路径可以在保留诊断后重写原文件，onboarding 的失败读取按空记录显示但不会覆盖原文件。

## 包与部署

| 事实 | 权威位置 |
|---|---|
| 哪些应用、哪些客户端包进入组合 | [deployment.yml](../packages/bundle/app-harness/deployment.yml) |
| 包名、版本、peer 与发布集合 | 各包 `package.json`；一致性由 `verify-version-sync` 检查 |
| bundle 的组成与发布物形态 | [交付设计](architecture/12-开发安装与发布.md) |
| 模块与依赖方向 | [架构总览 §2.1](ARCHITECTURE.md#21-模块与依赖方向) |

部署声明是行集合的真源；改应用行后运行 `node scripts/generate-bundle-patch.mjs` 和 `--check`，不要手改生成段。

## 维护说明

| 表 | 跟什么同步 |
|---|---|
| 符号速查 | 公开导出；改签名或新增入口时更新 |
| 错误码 | 运行时、模型端口与框架能力/任务/委托/事件入口产生的码；应用自定义业务码不在本表穷举 |
| 宿主状态文件 | host-bridge 的持久化文件名；改名或新增时同步部署声明 |
| 包与部署 | 只放指针，不复制清单 |

本页与《实现细节与验收》的分工：本页回答“叫什么、在哪、什么意思”，实现细节回答“现在做到哪、还差什么”。两者都不写会随发布变化的数字。
