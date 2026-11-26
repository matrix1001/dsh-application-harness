# 应用开发指南

> 类型：任务指南。当前实现与差异见 [11 §5](architecture/11-实现与验收.md#5-当前未完成与边界)。

本指南面向在本仓开发应用的作者，先完成一个可运行的最小应用，再按需增加数据、界面、跨应用协作和后台任务。环境安装与日常使用见 [README](../README.md)，设计约束见[架构总览](ARCHITECTURE.md)、[实现细节](architecture/11-实现与验收.md)与[设计专题](architecture/1-总体设计.md)，修改与验证规则见 [AGENTS](../AGENTS.md)。

## 阅读路径

| 目标 | 读 |
|---|---|
| 跑通第一个应用 | §1、§2.1–2.4、§8.1 |
| 加持久数据 | §4.1 |
| 加页面 | §5 |
| 应用之间协作 | §6 |
| 后台任务与生命周期 | §7 |
| 模型、网络、进程 | §4.2 |
| 会话委托 | §3.6 |
| 候选构建验收 | §8.2 |

第一次只读“跑通第一个应用”一行，其余按需查阅。

## 1. 开发前准备

先按[上手](START.md)跑起来，并确认默认应用能够启动。开发验证使用独立的 `DSH_HOME`、工作区、profile 和端口，配置规则见 [AGENTS](../AGENTS.md#环境与数据保护)。不要把日常实例作为测试数据来源或写入目标。

应用包含宿主声明与业务实现，可选配一个浏览器视图。人、AI 和其他应用都通过同一套公开操作访问业务；页面不直接访问数据库，应用也不读取其他应用的私有实现。

| 入口 | 用途 |
|---|---|
| [new-app.mjs](../scripts/new-app.mjs) | 创建宿主包、可选视图包，并接入构建列表 |
| [符号速查](REFERENCE.md#符号速查) | 声明、上下文、调用结果、存储与视图契约的定义位置 |
| [笔记宿主](../apps/notes/host/src/app.ts) / [笔记视图](../apps/notes/view/src/client/NotesView.tsx) | 数据、编辑与页面接入的真实示例 |

具体签名以源码为准。公开符号快照在 [api-snapshot.json](../scripts/api-snapshot.json)，用于检查接口变化，不代替符号说明。

## 2. 创建并运行第一个应用

### 2.1 生成骨架

在本仓根目录选择尚未使用的小写连字符名称：

```bash
node scripts/new-app.mjs my-app
```

无界面应用使用 `node scripts/new-app.mjs my-app --no-view`，两种方式任选一种，不要对同名目录重复生成；脚手架会写入目标文件。

默认生成以下内容：

| 位置 | 职责 |
|---|---|
| `apps/my-app/host/src/app.ts` | `MyAppDeclaration()` 与 `ping` 操作 |
| `apps/my-app/host/src/index.ts` | 注入 `applications`，通过 `mountApplication` 绑定生命周期 |
| `apps/my-app/view/src/client/index.ts` | 注册页面及本地化字典 |
| `apps/my-app/view/src/client/MyAppView.tsx` | 调用 `ping` 的基础页面 |
| 两个包的 `package.json` / `tsconfig.json` | 包声明、挂载行与项目引用 |

脚手架自动修改宿主／客户端 TypeScript 构建列表及客户端打包列表。它不生成业务测试，也不完成下文的部署、分层清单和契约快照接入。

### 2.2 声明与第一个操作

脚手架生成的 `apps/my-app/host/src/app.ts` 就是标准写法：`generation: 2` 加 `data: { kind: 'none' }`，一个 `effect: 'read'` 的 `ping` 操作，参数与结果都用平台的 JSON Schema DSL 声明。先按原样跑通，再按需要改这四处：

| 要改什么 | 字段 | 要点 |
|---|---|---|
| 身份 | `id`、`name`、`description` | `id` 用小写连字符，与包名和部署行一致；名称与描述会显示在管理界面 |
| 数据 | `data` | 没有持久数据用 `{ kind: 'none' }`；接入统一存储时改 `kind` 并声明 namespace，见 §4.1 |
| 读写语义 | `effect` | generation 2 的每个操作必须显式写 `'read'` 或 `'write'`；generation 1 缺省按写处理 |
| 开放范围 | `exposure` | 默认对 AI 关闭；确认行为后按 §3 的规则开放 |

加一个写操作时沿用同一结构，显式声明 `effect: 'write'`，并在保存成功后通知已打开的页面：

```ts
save: {
  description: '保存一条记录',
  params: { text: { type: 'string', required: true } },
  result: {
    type: 'object',
    additionalProperties: false,
    properties: { id: { type: 'string', required: true } },
  },
  effect: 'write',
  execute: (_args, ctx) => {
    ctx.notifyChanged()
    return { id: '…' }
  },
},
```

操作声明与 `defineOperation` 的用法见 §3；内置应用不强制使用该 helper。版本由脚手架写入，用 `--version` 生成时保持一致；视图显示名在生成的 `locales.ts` 里填写；宿主入口继续使用 `mountApplication`，不手写注册与卸载。

模板页面提供调用按钮，点击后显示 `echo`。它只验证首次调用；扩展为业务页面时按第 5 节接入共享布局、错误处理和状态管理。

### 2.3 接入部署与检查清单

在 [deployment.yml](../packages/bundle/app-harness/deployment.yml) 的现有 `applications` 列表追加：

```yaml
  - id: my-app
    package: '@matrix1001/dsh-application-harness-my-app'
```

有视图时，在现有 `client.packages` 列表追加 `@matrix1001/dsh-application-harness-my-app-view`，并在 [inject-contract.json](../scripts/inject-contract.json) 的 `inject` 对象中加入：

```json
"@matrix1001/dsh-application-harness-my-app-view": []
```

这里记录包的 `dsh.client.inject` 声明，不能把客户端源码里的 Cordis `inject = ['locale', 'applicationViews']` 抄到这个数组；二者用途不同。

其余接线与各自的校验器：

| 位置 | 加什么 | 写错时会怎样 |
|---|---|---|
| deployment.yml | 应用行 | `generate-bundle-patch --check` 或 `verify-deployment-descriptor` 报组合不一致 |
| `client.packages` | 视图包 | `verify-inject-contract` 报 drift；页面不出现时看客户端 boot 日志 |
| inject-contract.json | 客户端注入声明 | `verify-inject-contract` 指出具体包与差异 |
| verify-layer-deps.mjs | 应用与视图的层级清单 | 报 “workspace packages are in no layer” |
| tsconfig.test-paths.json | 测试按包名导入时的源码映射 | 测试解析失败；不要让测试读到旧的 `lib` |
| 包依赖与项目引用 | 新增跨包源码依赖时 | `pnpm run typecheck` 报缺少项目引用 |

应用行来自各包 `dsh.appRow`，部署描述决定哪些应用与视图进入组合。改完执行生成器并运行 `--check`，不手改 bundle patch 或 overlay 的生成段。

### 2.4 测试、构建与首次运行

创建 `apps/my-app/host/tests/my-app.spec.ts`，验证真实调用入口的成功、参数拒绝和调用范围拒绝（脚手架没有可触发的业务失败，业务失败按应用实际实现补测试）：

```ts
import { expect, it } from 'vitest'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { MyAppDeclaration } from '../src/app.ts'

it('校验输入并通过同一个操作回显消息', async () => {
  const runtime = new ApplicationRuntime()
  await runtime.register(MyAppDeclaration())
  try {
    expect(await runtime.call({ kind: 'human' }, 'my-app', 'ping', { message: 'hello' }))
      .toMatchObject({ status: 'success', result: { echo: 'hello' } })
    expect(await runtime.call({ kind: 'human' }, 'my-app', 'ping', {}))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.invalid-args' } })
    expect(await runtime.call({ kind: 'human' }, 'my-app', 'ping', { message: 1 }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.invalid-args' } })
    expect(await runtime.call({ kind: 'ai' }, 'my-app', 'ping', { message: 'hello' }))
      .toMatchObject({ status: 'rejected', error: { code: 'platform.not-open-to-caller' } })
  } finally {
    await runtime.stop('my-app')
    runtime.unregister('my-app')
  }
})
```

测试中的 `runtime.register` 等待启动结束；真实插件入口仍使用 `mountApplication`，让插件卸载与应用停止绑定。上述测试只覆盖声明与操作，还需按实际功能补宿主接入和视图测试，示例见第 8 节。

在本仓根目录运行：

```bash
node scripts/deps.mjs
node scripts/generate-bundle-patch.mjs
node scripts/generate-bundle-patch.mjs --check
pnpm exec vitest run apps/my-app/host/tests/my-app.spec.ts
pnpm run build:dev
node scripts/verify-layer-deps.mjs
node scripts/verify-deployment-descriptor.mjs
node scripts/verify-inject-contract.mjs
```

新增包会改变公开 API 集合。构建后审查新增导出，再运行 `node scripts/verify-api-snapshot.mjs --update` 并用不带 `--update` 的命令复核；不要用更新快照掩盖无关接口漂移。

在已隔离的开发环境中刷新 profile 并启动：

```bash
pnpm run setup --no-build
pnpm start
```

打开新应用页面并点击回显按钮，应得到 `{"echo":"hello from the page"}`。这是首次调用验证，不等于完整交付验收；提交前还需通过对应测试、覆盖率和契约检查。无界面应用在管理列表中确认注册，再从“管理 → 状态 → 调试调用”的折叠入口调用 `ping`。

## 3. 声明与实现操作

参数使用运行时导出的平台 schema 词汇，参数对象按名称描述字段，必填字段在该字段上声明 `required: true`；返回值按 `result` 声明。运行时负责结构校验，应用仍需校验长度、状态、对象归属、并发版本等业务条件。

需要把参数/结果 Schema 与 `execute` 的参数、返回类型绑定在同一份声明时，可用 `defineOperation`。它是可选 helper；内置应用因为还要统一处理 `ensureLoaded`、变更通知和只读/写入 exposure，仍使用自己的 lifecycle-aware builder。

```ts
import { defineOperation } from '@matrix1001/dsh-application-harness-runtime'

const ping = defineOperation({
  description: '回显一条消息',
  params: { message: { type: 'string', required: true } },
  result: {
    type: 'object', additionalProperties: false,
    properties: { echo: { type: 'string', required: true } },
  },
  effect: 'read',
  exposure: { ai: 'closed', peers: 'closed' },
  execute: (args) => ({ echo: args.message }),
})
```

generation 2 的每个操作都必须显式声明 `effect`，读取写 `effect: 'read'`；generation 1 缺省按写处理。`effect` 用于读取声明、界面和审计说明，不是 AI 可调用面的唯一过滤条件；读取不能修改持久状态或产生外部副作用，联网刷新等操作不能为了出现在读取目录里而标为读取。

| 开放设置 | 使用方式 |
|---|---|
| `exposure.ai: 'closed'` 或省略 | AI 不可调用；页面仍可按人的调用规则使用 |
| `exposure.ai: 'open'` | 对 AI 无需确认；用户策略可覆盖为确认或禁止 |
| `exposure.ai: 'confirm'` | 对 AI 默认需要确认；用户策略可覆盖 |
| `exposure.peers: 'open'` | 对其他应用默认无需确认；仍要求调用方声明、目标声明和用户策略允许 |
| `exposure.peers: 'confirm'` | 对其他应用默认需要确认；无交互时拒绝 |

导出、不可逆删除和低层接口保持 AI 关闭。外部正文是数据；列表返回有界摘要，正文按条读取。完整规则见[权限与调用](architecture/3-权限与调用.md)。

AI 调用面只有一个固定的 `applications` 工具（查看/读取声明/调用），不会为每个操作生成常驻工具。普通会话只允许使用用户在本轮 `@` 的应用；应用区会话可使用所有应用。两者都按作者默认与用户对操作的一条覆盖策略执行，写操作不因入口不同被整体排除。

`CallOutcome` 是带 `callId` 与五态 `status` 的联合：成功读 `result`，拒绝/失败/取消/未知读 `error.code`/`error.message`；不再有 `value`/顶层 `code`/`message` 别名。平台错误码以 `platform.` 开头，业务错误码以 `app.` 开头。操作通过 `AppError(code, message)` 返回可识别的业务失败，调用方按 `CallOutcome.status` 区分成功、拒绝、失败、取消与结果未知。

拒绝表示操作未执行；失败和未知可能已经产生效果，调用方应按业务是否需要读取当前状态。通信断开还可能直接抛错，不能假装成一次已知的业务失败。

耗时操作传递 `ctx.signal`，按需使用 `ctx.reportProgress`；已完成的写入不因取消而自动回滚。

需要幂等的写操作显式声明参数 `requestId`，将它与业务记录或结果一起保存。同一意图重试复用该值，内容改变采用新值。页面 `call` 的第三个参数只用于传输关联和取消，不会自动写入业务参数；若两者都需要，分别传入。参考[笔记创建与 receipt](../apps/notes/host/src/app.ts)。

## 3.1 声明和订阅业务变化

发布方声明事件，订阅方声明来源；两边都只描述协作范围，实际投递还需要用户授权。订阅方可以在启动时登记意图（发布方尚未注册、或已注册但事件暂未开放，都不报错，也不阻断启动），平台在**投递时**检查当前声明与授权：未授权不投递，授权后立即生效，撤销后停止后续投递，重新授权自动恢复，都不需要重启订阅方。

```ts
const declaration: AppDeclaration = {
  // ...
  events: {
    'entry.created': { description: '收件箱条目已创建', subscription: 'open' },
  },
  ops: {
    save: {
      // ...
      execute: (_args, ctx) => {
        ctx.publishEvent('entry.created', [{ appId: 'inbox', type: 'entry', id: '123' }])
        return { saved: true }
      },
    },
  },
}
```

订阅方：

```ts
const subscriber: AppDeclaration = {
  // ...
  subscriptions: [{ appId: 'inbox', type: 'entry.created' }],
  start: async (ctx) => {
    const stop = await ctx.subscribe('inbox', 'entry.created', async (event) => {
      // 只拿 refs；按权限调用应用操作读取最新状态。
      console.log(event.refs)
    })
    ctx.signal.addEventListener('abort', stop, { once: true })
  },
}
```

事件只含类型、时间与 `ObjectRef[]`，没有正文或字段值；`refs` 只能指向发布方自己的对象。投递是实时、尽力，不保存历史。投递需要用户授予 `event:<appId>#<type>` 能力：未授权时不投递（订阅意图保留），授权后立即生效；撤销只停止后续投递，重新授权自动恢复。订阅方停止后订阅结束。不要用事件代替需要可靠处理的业务队列。

## 3.2 声明可解析的对象类型

```ts
objectTypes: {
  task: { description: '任务', resolveOperation: 'resolveTask' },
},
ops: {
  resolveTask: {
    description: '按 id 返回任务的展示信息',
    params: { id: { type: 'string', required: true } },
    result: { type: 'json' },
    effect: 'read',
    execute: (args) => ({
      ref: { appId: 'todo', type: 'task', id: args.id },
      title: '准备季度报告',
      summary: '进行中',
    }),
  },
},
```

解析操作必须是只读操作，返回的 `ref` 必须与应用、类型和 ID 一致；平台按真实调用方权限调用。解析只返回标题/摘要，不返回完整业务对象，也不能用摘要推断其他字段。

## 3.3 页面服务与固定动作

页面声明与逐视图固定动作清单已延期；应用通过 `ApplicationViewProps.pageActions` 接收 `set-filters`/`select` 固定动作，动作只改 UI 状态，不写业务数据；`navigate` 由页面服务在外壳执行。`pages.open` 的 `view` 由应用页面路由解释，平台只校验 record 属于当前应用。
`pages.open`/`pages.act` 成功只回执 `{ accepted: true }`；随后用 `pages.read` 读取 `pageId`、`snapshotId` 和页面上下文。`pages.read` 的 `pageId` 可选，传入时会校验当前页面，旧 id 返回 `pages/stale-snapshot`。

## 3.4 开发会话

应用区菜单的“开发此应用”会在用户选择的源码工作区中创建一个独立 Session，并在宿主登记为当前应用的开发会话。该 Session 只获得这一应用的操作工具；对绑定应用的写操作逐次确认。源码修改不会自动替换运行版本，构建、隔离验证和候选加载仍按开发流程单独执行。

开发会话绑定一个应用，`applications` 工具只作用于该应用；写操作在开发会话中强制逐次确认，读操作仍按普通策略。绑定后 Session 不能通过同一工具直接调用其他应用；应用间的已声明协作链路仍按运行时权限检查。应用区菜单已经提供开发会话入口，`node scripts/new-app.mjs` 提供源码模板，`pnpm run validate:app` 提供隔离验证实例；三者尚未合并成一个向导式入口。

### 3.5 显示跨应用引用

页面可直接使用共享的对象引用组件：

```tsx
import { ObjectReference } from '@matrix1001/dsh-application-harness-client-object-reference'

<ObjectReference
  object={{ appId: 'notes', type: 'note', id: 'n1' }}
  resolve={resolveObject}
  onOpen={() => navigation?.open({
    appId: 'notes',
    record: { appId: 'notes', kind: 'note', id: 'n1' },
    view: 'detail',
  })}
/>
```

组件未传 `title` 且拿到 `resolveObject` 时自行解析标题和摘要；显式 `title` 会跳过解析。`app.not-found`（对象已删除）显示不可用；无权或其他解析失败保留原引用并暴露错误，不要显示缓存正文。无本地打开方式时用 `onSwitch` 切到拥有者应用。`navigation.open` 的 `record` 是页面记录（`kind`），不是 `ObjectRef.type`。

### 3.6 会话委托

应用要创建、读取或取消自己的委托记录，先在声明中加上 `delegate` 能力，并由用户在“管理 → 权限与连接”中授权：

```ts
const declaration: AppDeclaration = {
  // ...
  capabilities: ['delegate'],
}
```

未声明返回 `app.capability-undeclared`，声明未授权返回 `app.capability-not-approved`；发送始终由用户在发送对话框中确认，不受这个能力门影响。完整契约见[会话委托](architecture/9-会话委托.md)。

## 4. 管理数据与使用能力

应用直接模型请求使用 `createPlatformModelPort(ctx, '<appId>')`；用户在“管理 → 权限与连接”的模型选择区可从平台模型目录选择供应商与模型，或保持“跟随默认”。固定路由只影响直接模型请求，不改变委托会话的模型，也不授予模型能力。

笔记等编辑器应用已在页面内接入“共享给 AI”：共享 `/body` 与 `/tags`，AI 的读取/更新经页面 controller，先比较 revision；用户可随时停止共享。

“管理 → 权限与连接”显示该应用的调用/成功/失败/取消次数、总耗时、已知 token、用量缺失次数，以及最近一次模型和状态；未知 token 显示“未提供”，不能当作 0。这里还可关闭后台模型调用、设置并发/每分钟次数上限；后台调用需在请求中标记 `background: true`。



### 4.1 数据声明与存储接入

按实际形态填写 `data`：`none`、`unified`、`own-sqlite` 或 `files`。声明 namespace 或路径、schemaVersion、备份策略以及可选导入导出操作；规则由 [AppDataDeclaration](../packages/application/runtime/src/types.ts) 定义。应用只处理自身数据，整库备份和恢复由宿主负责。

为最小应用增加统一存储时：

1. 宿主包声明 store 依赖及 TypeScript 项目引用，插件入口在 `inject` 增加 `applicationStore`（用于等待服务就绪）。
2. 在插件入口使用 `mountApplication<GatedStore>(ctx, store => ...)` 的工厂取得 `store('my-app')`；runtime 会校验声明 namespace 与应用 id，返回的 `GatedStore` 注入业务对象。不要从 `ctx.applicationStore` 自取任意 namespace，也不把数据库连接交给业务。
3. 应用声明增加 `capabilities: ['storage']` 与 `data: { kind: 'unified', namespace: 'my-app', schemaVersion: 1 }`。
4. 在应用 `start` 中用 `store.attach(ctx.capabilities)` 绑定能力检查。未授权时读取应明确失败；不要为通过启动而自行授权。笔记采用启动时绑定、首次操作时读取的方式。
5. 使用 `documents.get/put` 或集合接口；文档写入通过 `expectedRevision` 检查并发。事务回调必须同步，不能保留回调拿到的原始句柄。
6. 保存完成后调用 `ctx.notifyChanged()`。如果业务对象缓存文档，提供 `reload` 重新读取，以配合宿主导入与恢复。

完整接线见[笔记插件入口](../apps/notes/host/src/index.ts)，加载、版本检查与写入队列见[笔记仓库](../apps/notes/host/src/app.ts)。缓存读取同样需要尊重权限撤销，不能因数据已经在内存中而绕过授权。

文件不存在可以按首次运行处理；已存在但读取、解析或版本校验失败时必须保留原内容并拒绝覆盖，不能退回默认空数据后继续保存。应用负责 schema 升级与业务校验，统一存储不会替它解释业务文档。

### 4.2 网络、模型与进程

声明能力只表明需要使用，用户仍需授权。使用操作或任务上下文中绑定的能力入口，不从业务参数接受应用身份。

| 需要 | 接入方式与示例 |
|---|---|
| 网络 | 声明 `network`，在 `ctx.capabilities.use('network', work)` 内调用注入的 `applicationHttp.getJson`；传递取消信号并限定时长和返回体大小。见 [HTTP 服务接口](../packages/application/http/src/index.ts)。该服务负责传输限制，能力检查仍须由应用绑定。 |
| 模型 | 声明 `model`，宿主构造 `createPlatformModelPort` 并注入业务；`ask` 接收当前调用的 `capabilities`、`signal` 和输入输出限制。见[模型接口](../packages/application/host-bridge/src/model.ts)与[笔记入口](../apps/notes/host/src/index.ts)。 |
| 子进程 | 声明 `process` 能力和 `process: [{ executable, commands, purpose }]` 命令清单，在 `ctx.process.run({ command }, work)` 内使用平台 subprocess；平台记录命令名称并检查能力授权，超时与输出上限在适配器内处理，终止和取消信号由平台 subprocess 负责。见 [Git 插件入口](../apps/git-browser/host/src/index.ts)和[进程适配器](../apps/git-browser/host/src/subprocess.ts)。 |

进程声明与调用示例：

```ts
const declaration: AppDeclaration = {
  // ...
  capabilities: ['process'],
  process: [{ executable: 'git', commands: ['status', 'diff'], purpose: '只读查看仓库状态与差异' }],
}

// 在操作/任务上下文里：
await ctx.process.run({ command: 'git status' }, async () => await runGit(['status']))
```

平台记录命令名称并检查 `process` 授权；实际 spawn、终止和取消信号由平台 subprocess 服务执行，超时与输出字节上限由应用适配器施加，声明不是执行级白名单。

默认代理由启动器和平台传输策略统一处理：应用不再解析一份 `HTTP_PROXY` / `NO_PROXY`，`applicationHttp` 沿用平台出口。用户需要另一种应用后端出口时，在「应用管理 → 应用网络代理」设置一次（对全部应用后端生效，模型调用不经过它）；应用代码不读取也不配置代理。模型入口提供单轮调用，应用自己决定发送哪些数据和如何使用结果，不复制平台模型、凭据或会话系统。

## 5. 开发应用界面

### 5.1 注册页面与调用操作

客户端通过 `ctx.applicationViews.register(appId, view)` 注册页面，可选提供 `Settings`。注册用 `ctx.effect` 绑定插件生命周期；显示名与描述使用 locale 字典，页面订阅 locale 变化。参考[笔记视图注册](../apps/notes/view/src/client/index.ts)。

视图通过框架传入的 `ApplicationViewProps` 工作：

| 接口 | 页面如何使用 |
|---|---|
| `call` / `cancel` / `running` | 调用本应用操作、取消在途请求并阻止重复提交；同时处理返回状态与通信异常 |
| `onChanged` | 先订阅、再首次读取；收到变化或重连通知后重读，忽略过期响应 |
| `pageContext.report` | 从 effect 报告当前页面引用，返回清理函数；只传身份和有界上下文，不传正文或草稿 |
| `ui` | 保存同一浏览器页面生命周期内的选中项、筛选和临时输入；刷新后的恢复由应用另行负责 |
| `viewport` / `navigation` | 报告视图滚动状态，处理跨应用导航和离开保护；完整字段见界面契约 |
| `resolveObject` | 按 `ObjectRef` 调用目标应用声明的解析操作，返回标题/摘要或失败原因（值，不抛异常）：`app.not-found` 表示对象已不存在，其他错误码表示这次无法确认；只做展示，不扩大读取范围 |
| `pageActions.onAction` | 注册 `set-filters/select` 固定动作的页面 controller；动作只改 UI 状态，不写业务数据 |
| `drafts.share` / `drafts.revoke` / `drafts.onRead` / `drafts.onUpdate` | 用户显式共享草稿后，登记 controller；平台只保存字段范围与 revision，正文留在页面；用户可随时撤销共享；版本冲突由页面返回 conflict |
| `openManagement` | 打开本应用管理入口；不能因此授予权限 |

页面引用报告不等于宿主已经支持该记录族；需要核对[上下文接入](../packages/application/context/src/index.ts)的解析与验证能力，并提供对应的只读业务事实。

### 5.2 共享布局、草稿与反馈

业务页面使用共享 [chrome 组件](../packages/client/chrome/src/index.tsx)及[样式变量](../packages/client/applications/src/client/tokens.module.css)。增加 chrome 依赖时同步包声明与 TypeScript 项目引用；chrome 是可内联静态库，其他客户端插件的运行时协作仍通过服务完成。

按 DSH Client 插件规则，生产 client 代码不得 value import `@deepseek-ai/dsh-client-*`（包括 primitives、dockkit、store、settings）；需要平台类型时只使用会被擦除的 `import type`。`check-client-ui-imports` 在 gate 中强制执行这条规则。

- 全屏型业务页面注册 `contentLayout: 'fill'`，文档流页面注册 `flow`；根节点使用 `flex: 1 1 auto` 和 `min-height: 0` 获取真实剩余高度，滚动区放在页面内部，不用 `100vh - 常数` 估算。
- 第一行使用共享 `TabBar`，搜索与主动作放入 `tools`。外壳已经提供应用名称和页边，不重复品牌栏或再加一层页面内距。
- 字号、间距和内容宽度使用共享变量；详情浮层以页面根为定位容器，不遮挡页签和顶栏。具体布局约束见[页面与人机交互](architecture/7-页面与人机交互.md)。
- 使用 `onChanged` 重读数据时保留草稿；保存时捕获提交版本，成功只清除该版本，不能清除用户在等待期间的新输入。
- 设置采用明确保存，失败保留输入。`ui` 只能存 JSON 数据；服务、DOM、Promise 和订阅句柄不能放入界面状态。
- 首次读取失败显示“尚未读取”及原因，不显示成功的空列表；后续读取失败保留已有内容。权限错误按 code 处理，权限动作由应用区页头的状态控件承担，页面只说明尚未读取并指向它；恢复后只重试读取，不重放写操作。局部操作错误留在操作附近，原始 code/message 放在诊断折叠里。
- 页面级空态使用共享 `EmptyState`（面板内用 `compact`），工具行使用 `Toolbar`，瞬时提示使用 `NoticeLayer`/`BusyBar`，设置页使用 `SettingsLayout`/`SettingsGroup`/`SettingRow`；不要为同一结构再复制一套样式。
- 需要确认的动作和未保存离开守卫使用 `useConfirm`（Promise 语义，返回是否继续）；不要再调用 `window.confirm`/`window.prompt`。
- 提示使用共享浮层，表单校验留在字段旁；页签、弹框和菜单提供键盘操作、焦点恢复与稳定的 `data-*` 测试锚点。

完整编辑示例见[笔记页面](../apps/notes/view/src/client/NotesView.tsx)，客户端用例见[笔记视图测试](../apps/notes/view/tests/NotesView.client.spec.tsx)。

## 6. 应用之间的协作

调用方在声明中列出确切操作，例如：

```ts
calls: [{ app: 'notes', ops: ['create'] }],
```

操作执行中使用 `ctx.call('notes', 'create', { body, requestId })`，按返回状态处理结果。目标操作必须对 `peers` 开放，用户对该操作的策略必须允许（或按策略确认）；不能用人的身份代替应用身份，也不能直接实例化目标的仓库来写数据。

例如收件箱把条目存为笔记：收件箱保存来源引用并构造幂等请求，笔记通过自己的公开操作创建记录和保存 receipt。网络断开或结果不确定时，重试同一个意图复用请求身份。参考[收件箱](../apps/inbox/host/src/app.ts)和[笔记](../apps/notes/host/src/app.ts)，跨应用多步操作不具有自动整体回滚。

需要打开目标页面时，用 `navigation` 发送包含 `appId` 和记录身份的导航意图；目标页面消费自己的路由，编辑页注册离开保护。不要通过 DOM 查找或直接修改其他页面状态。导航不会授予调用权限，记录引用也不能替代读取时的校验。

## 7. 生命周期与后台任务

使用 `mountApplication` 后，应用启停随插件生命周期管理。`start` 负责绑定资源，`stop` 停止新工作并释放资源；启动未完成时不可调用，卸载期间到达的启动结果不能重新开放应用。耗时工作要配合取消，不能把超时当作已停止。

超出一次操作生命周期的工作使用 `OperationContext.startTask` 或 `AppContext.startTask`。描述中提供业务类别、标题，可选携带业务记录 `externalId` 与幂等 `requestId`；回调通过任务自己的 `signal`、`capabilities`、`reportProgress`、`notifyChanged` 和 `publishEvent` 工作；`publishEvent` 在任务所属应用已声明该事件类型时发出变更通知。操作返回 `taskId` 让页面跟踪，不把未结束的工作伪报为成功。

`TaskHandle.done` 只表示任务已经结束，不会以 rejection 表达任务失败；结果要查看任务状态。业务记录由应用持久保存，任务快照只负责统一展示进度和取消。重启后在途任务变成 `interrupted`，框架不自动重新执行。

定时刷新、单次执行保护、进度节流与业务 receipt 可使用运行时导出的 `runPeriodically`、`SingleFlight`、`ProgressReporter`、`TaskReceipts`，具体契约见 [task-helpers.ts](../packages/application/runtime/src/task-helpers.ts)。示例见[收件箱后台刷新](../apps/inbox/host/src/app.ts)。

有缓存或定时工作的应用还需要配合数据管理：`pause` 暂停启动新后台工作，宿主排空在途调用后写入并通过 `reload` 重读，维护结束由 `resume` 恢复。不要把这些钩子写成新的业务操作或自行绕过维护状态；失败和预算要求见[应用结构与运行](architecture/4-应用结构与运行.md)。

## 8. 测试、调试与交付

### 8.1 按行为组织测试

| 测试 | 重点与现有示例 |
|---|---|
| 业务和调用契约 | 正常输入、业务拒绝、授权缺失与撤销、并发版本、幂等、变化通知；[笔记测试](../apps/notes/host/tests/notes.spec.ts) |
| 数据恢复 | 重启加载、损坏数据保留、导入预览与冲突、恢复后重读；应用自有存储测试与[宿主恢复测试](../packages/application/host-bridge/tests/restore.spec.ts) |
| 视图及注册 | 真实结果形状、加载与错误、草稿、键盘与 locale；[笔记视图测试](../apps/notes/view/tests/NotesView.client.spec.tsx)和[注册测试](../apps/notes/view/tests/Plugin.client.spec.ts) |
| 生命周期与后台任务 | 启动中卸载、取消、停用超时、维护暂停、任务与业务终态一致；[运行时测试](../packages/application/runtime/tests) |
| 部署与浏览器 | 应用可见、实际调用、授权和对话链路、窄屏与主题；验证实际加载的构建产物，不能仅依赖单元测试 |

执行与改动范围对应的检查，完整要求见 [AGENTS](../AGENTS.md#验证)。新增应用必须补齐宿主和可选视图的测试并达到 [vitest.config.ts](../vitest.config.ts) 的覆盖率要求；完整检查可用 `pnpm run release:check`，它不发布或部署。

### 8.2 隔离验证候选构建

先用 `pnpm run build:dev` 构建当前工作区，再用隔离实例验证候选，不读写日常 `DSH_HOME`、profile、工作区和端口：

```sh
pnpm run validate:app -- --app notes
# 指定端口、保留临时世界
pnpm run validate:app -- --app notes --port 3200 --keep
```

脚本在 `tmp/validation-<app>/` 下建立一次性 `HOME`、`DSH_HOME`、`application-harness` profile 和工作区，启动安装线的 `@deepseek-ai/dsh`（`node_modules/@deepseek-ai/dsh/lib/bin.js`），打印带 token 的 URL；退出时默认删除临时世界，`--keep` 保留。它验证的是当前构建产物，不会把候选应用到日常部署；正式升级仍是显式部署动作。

### 8.3 常见接入问题

| 现象 | 核对位置 |
|---|---|
| 应用未出现 | `deployment.yml`、包内 `dsh.appRow`、生成器检查、profile 是否刷新；同时看宿主插件 warning |
| 宿主已注册但页面没有出现 | `client.packages`、视图 `appId`、客户端注入与 boot 日志、视图注册和产物是否已刷新 |
| 新包被分层检查拒绝 | `verify-layer-deps.mjs` 中是否登记正确层级，以及是否跨越依赖边界 |
| 应用一直不可用 | `start` 是否结束、依赖是否注入、是否在启动时等待尚未授权的业务读取 |
| 缺少能力 | `capability-undeclared` 修正声明；`capability-not-approved` 由用户去权限页授权，应用不能自行授权 |
| AI 看不到操作 | 检查开放规则、读写语义、当前是否为应用区会话；普通会话还要求先引用应用 |
| 修改源码后行为不变 | 重建 host/client，检查实际加载产物；客户端刷新，host 按 HMR 重组条件加载或重启 |
| 测试通过但运行失败 | 检查是否测了旧构建、部署是否遗漏能力，以及安装的 DSH 平台线是否与声明版本一致 |

会话确认、非 owner Peer、真实外部动作、真实缩放和读屏的验收边界见[实现细节与验收的验收边界](architecture/11-实现与验收.md#6-验收边界)。验证结论在对话或提交说明中报告，不写成指南里的永久“已通过”声明。
