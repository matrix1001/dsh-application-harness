# AGENTS.md

本文件规定如何修改仓库。使用入口见 [README](README.md)，设计依据见[架构总览](docs/ARCHITECTURE.md)、[实现细节](docs/architecture/11-实现与验收.md)与[文档地图](docs/README.md)，应用接入见[应用开发指南](docs/APPLICATION_DEVELOPMENT.md)。

## 协作与决策

- 使用中文，直接说明为什么做、怎么做，避免叙事和不必要的术语。
- 设计逐条讨论，推荐并说明理由后等待用户定案；已确认的决定直接执行，不反复申请确认。
- 修改前阅读相关文档、源码和测试，核对实现差异；不回滚用户已有的无关修改，不使用破坏性 Git 命令。
- 架构文档是已确认的设计依据。实现与设计不一致时明确差异并修复，不把目标当作已实现，也不为迁就旧实现改回设计；设计变更须重新定案。

## 文档职责

本项目维护以下文档，按读者任务分工：

| 文档 | 职责 | 何时更新 |
|---|---|---|
| [README](README.md) | 项目愿景、与 DSH 应用的差异、内置应用、安装与使用 | 产品定位、内置应用或安装方式变化 |
| 本文件 | 协作、工程约束、数据保护、验证与交付规则 | 修改仓库的方法和约束变化 |
| [架构总览](docs/ARCHITECTURE.md) / [实现细节](docs/architecture/11-实现与验收.md) | 组成与依赖总览、当前实现细节、验收边界和未完成项 | 实现结构或行为变化 |
| [文档地图](docs/README.md) | 文档入口、阅读路径、事实优先级与设计专题索引 | 文档结构或设计专题变化 |
| [应用开发指南](docs/APPLICATION_DEVELOPMENT.md) | 创建、实现、接入、测试和调试应用 | 应用作者需要采用的新接口或步骤变化 |

- 同一规则在所属文档完整定义，其他文档保留必要提醒和链接；具体类型、参数和实现细节以源码及测试为准，不维护第二套 API 定义。
- 开发指南示例必须对应当前源码，README 的功能介绍只写已实现行为。未实现的设计要求或冲突须明确标出，不以文档重排隐含改变设计。
- 不新增包 README、翻译副本、独立计划、待办或历史归档。第三方源码附带文档与许可证保留；CLAUDE.md 仅作为本文件的链接。
- 历史通过 Git 查询。验证结果和修改范围在对话或提交说明中报告，不再生成交付文档。

## 修改原则

- 以已确认的架构调整接口和包结构，应用同步适配，不引入无必要的旧接口兼容层。用户业务数据另行处理，不随重构删除。
- 先改核心类型和契约，再改调用接入与客户端，避免重复定义同一事实。
- 跨 workspace 包的源码导入必须有完整的 TypeScript 项目引用。客户端运行时依赖遵守平台模块与声明的外部依赖规则，跨插件值协作使用平台服务。
- 复用平台能力前核对实际契约与测试，尤其是 Agent、会话轮次、权限和资源归属要求。遵循架构的复用边界，不复制平台实现，不为适配接口虚构会话；必要的应用身份与权限接入保留在本项目。
- 不对整个运行中的服务或上下文对象做序列化或克隆，只读取需要的字段。
- 纯文档清理不削弱业务测试；业务数据的恢复路径由应用自有存储的测试覆盖，不为旧数据或旧格式保留兼容代码和专属用例。

## 环境与数据保护

- 依赖一律使用 `node scripts/deps.mjs`。pnpm store 留在仓内 `.pnpm-store/`，npm cache 留在 `tmp/npm-cache`。
- 跨命令使用的临时材料放仓内 `tmp/`，不依赖受限环境的 `/tmp`；不要让文档引用临时材料作为长期依据。
- 一个 `DSH_HOME` 只由一个宿主写入。验证实例必须隔离家目录、工作区、profile 和端口，不使用日常运行实例。
- 工作区由 `scripts/workspace.mjs` 解析：`DSH_WORKSPACE` 优先，否则为 `~/dsh-workspaces/<profile>`；不得位于本仓或平台 checkout 内。启动时分别核对代码来源和工作区绝对路径。
- 开发期的一次性浏览器验收实例，如需避免沙箱升级，可把 `DSH_HOME`、profile、工作区与端口全部放在仓内 `tmp/<name>/` 下，并直接用平台 checkout 的 `apps/cli/lib/bin.js` 启动，不经过 `launch-apps.mjs` 的仓内工作区防护。这些目录只用于临时验收，不提交、不当作日常实例，也不得让正式实例读写它们。
- 数据路径以[部署声明](packages/bundle/app-harness/deployment.yml)为准，不在模块级增加隐式路径。修改前核对实际绑定，不因旧应用代码已删除而清理其数据。
- `DSH_WORKSPACE_LEGACY` 指定旧数据目录候选，空串表示没有候选。采用必须在交互终端展示来源和目标，由用户输入 `yes` 确认。非交互启动或未确认时拒绝搬移；确认后只把整个 `.dsh-applications` 目录移入工作区，不做格式转换；两个位置都有数据时拒绝启动，不合并、不猜测、不静默创建空数据。
- `pnpm run clean` 默认只清理构建产物和临时材料。清理业务数据须明确授权及目标路径；工作区数据只能通过显式 `--purge-data --workspace <dir>` 指定。

遇到本机 Git 配置环境污染时，在命令前加 `GIT_CONFIG_COUNT=0`；pnpm shim 无法执行时使用 workspace 工具或可用的真实 pnpm 二进制。这些是环境排障方式，不改变验证结论。

## 发布与安装

- 自有包统一使用 `@matrix1001/dsh-application-harness*`，不再使用 `@deepseek-ai` scope。插件通过 **GitHub Releases 上的单个自包含 tarball** 分发，不依赖 npm 账号、scope registry 或 GitHub Pages；tarball 由 `node scripts/build-plugin-tarball.mjs` 生成，必须包含 23 个自有 row 包和 `bundleDependencies`，平台包仍是 peer。
- 版本是独立的 SemVer release train：bundle 是 release entry，26 个可发布包同版本（`packages/typert/protocol` 跟平台线、豁免）。用 `node scripts/version.mjs <version>` 一次更新全部 manifest 和 node_modules；main 在发版后进入下一个 `-dev.N`，tag 只打正式版本 `vX.Y.Z`。
- main 的日常构建走平台 checkout（`pnpm run build:dev`）；发布走 npm 线（`pnpm run build` / `node scripts/build-release.mjs`）。`node scripts/test-plugin-local.mjs` 会自动跑 npm 线、生成自包含 tarball、在隔离 web profile 中执行 `dsh plugin add`，然后恢复 checkout 线构建。
- 日常开发用 `node scripts/dev.mjs`：一条命令做初始构建、可选生成 host HMR overlay、启动 dsh web，并通过串行去抖构建更新 host/client 产物。client 变更重建后手动刷新；host 变更默认重启 dev。`--hmr` 是实验性 host HMR overlay，不作为默认，也不做自定义重载按钮/route/`pnpm reload`。
- bundle 的 23 个 row 包必须写在 bundle 的 `dependencies` 中（profile 固定 `autoInstallPeers: false`，peer 不会被安装）；平台 `@deepseek-ai/dsh-*` 包保持 peer，由宿主提供。`scripts/verify-build-role.mjs` 守护这条闭包。
- 安装验证必须在隔离的 `DSH_HOME`、web profile 和独立端口（如需要）中进行，安装自包含 tarball；不得写 scope registry，也不得把平台依赖路由到本仓分发。验证 `dsh plugin add` 后 23 个嵌套自有包可解析、bundle 层已加入、Web 侧栏保留。
- 发布 tarball 不包含平台包；不要把平台实现打进 bundle，也不要在安装时运行作者构建脚本。
- 发布前运行 `node scripts/verify-release-line.mjs`：checkout 版本、声明线、快照 commit 与 npm registry 必须一致。checkout 领先 npm 时不发版，等 npm 追上后再 `platform-line --set` / `--snapshot` / `release:check`。
- tag 发布由 `.github/workflows/release.yml` 执行：`release:check`、`test-plugin-local --no-restore`、自包含 tarball、GitHub Release asset；首次发布仍需手动定版本并打 tag。

## 平台与生成文件

### 平台源码与契约

- 平台 checkout 长期跟踪 `master`，优先适配平台变化，不建议退回发布标签；npm pin 约束类型、CI 和发布面，不替代 checkout 执行线。
- 涉及平台内部先读**平台 checkout**，即执行线实际加载的代码。`.platform-src/*/src/` 是声明线的测试解析快照，只用于测试与哈希比对，不能当作当前 checkout 契约；只有源码无法回答实际部署问题时才编写最小探针。
- 平台升级同时核对依赖、包拆分与改名、运行时下限、源码快照、生成协议、部署声明、工具执行器、客户端插槽及实际加载产物。旧快照检查通过不等于已与当前 checkout 兼容。
- DSH 升级适配走固定四步：机械对齐（`node scripts/platform-line.mjs --snapshot` 按需重录、`node scripts/platform-compat.mjs` 出失败簇）→ 维护者本地的 `platform-adapt` workflow 出只读计划 → 用户确认后执行 → `pnpm run release:check` 收口。机械面（pin/engines/workspace/lock）不手工改；语义修复不引入旧接口兼容层。
- 日常开发默认走平台 checkout：`pnpm dev` / `pnpm run typecheck` 用 `scripts/platform-types.mjs` 生成的 checkout 声明快照（tsc 期间临时替换 base paths，tsdown 前恢复）；`pnpm run build` / `release:check` 仍走 npm 线，命名上用 `typecheck:release` 与 `build:dev` 区分。
- `.platform-src/*/src/` 与 `packages/typert/protocol/src/` 不手改。后者跟随 checkout，唯一本地差异是移除 `declare module '@deepseek-ai/cordis'` 的 Context 增强；`vendor-platform-src.mjs --check` 在比较前归一化该块。
- 客户端测试默认使用 `.platform-src`。是否改用发布物，须逐包核对 Node 导出与完整依赖，不能把浏览器 factory 当作普通 ESM 执行，也不能仅因快照含上游测试源码就视为可用。
- 快照包清单由 `scripts/platform-contract.mjs` 的 `VENDOR_PAIRS` 维护，来源、版本和提交以 `scripts/platform-src-lock.json`、平台契约脚本和部署描述为准，不在文档重复固定值。
- 记录快照使用 `node scripts/vendor-platform-src.mjs --record --checkout <dir>`；取 checkout 提交时显式传入 `--commit <sha>`，并执行 `--check` 和平台模块检查，不能把默认取标签当作跟踪 checkout。
- 插件兼容性优先看 `engines.dsh`；一旦声明，dsh peerDependencies 就被忽略。它必须是语义化范围，不能写 `workspace:*` 或裸精确版本。部署包采用与本仓脚手架一致的范围，由 `scripts/verify-engines.mjs` 校验覆盖部署声明的 `declaredLine`。

### 部署与生成

- `packages/bundle/app-harness/deployment.yml` 是部署声明真源。应用挂载行修改包内 `dsh.appRow`，运行 `node scripts/generate-bundle-patch.mjs`，再运行其 `--check`，不手改生成段。
- 本仓保留平台默认 `ui-sidebar`：applications 包通过 `sidebar.panellist` 注册入口、通过 keyed `main` 注册应用区，不占用单槽 `sidebar`。生成器只把 bundle patch 的机械行同步到 web overlay；改动后重跑生成器与 `--check`，不手改生成区。
- 使用 `scripts/setup.mjs` 刷新 profile；日常启动用 `pnpm start`，不要重复安装 profile。不手改 profile 中本仓生成的依赖和模板，不覆盖平台维护的用户设置、插件依赖和构建批准。
- host 代码必须重建；默认 `pnpm dev` 不带 HMR，改 host 后重启 dev。`pnpm dev --hmr` 是实验性 host HMR overlay；linked 包的依赖级联可能重置连接，不作为稳定契约。client 代码必须重建并手动刷新；dev overlay 禁用平台 `client-hmr`。平台不监视本仓源码，只改 `src` 不重建不会生效。验证前检查实际加载产物。

## 验证与交付

按修改范围选检查；多项变化合并覆盖，不把命令清单当作每次都要重复运行的固定流程。

| 修改范围 | 所需检查 |
|---|---|
| 文档及文档指引 | 核对源码、命令、相对链接和章节锚点；运行相关文档或脚本测试 |
| 业务或客户端行为 | `pnpm run typecheck`、相关测试、`pnpm run test:coverage`；涉及界面另做浏览器验证 |
| 公共 API、传输协议 | 对应类型、调用与协议测试，更新必要的 API／协议契约快照并运行对应检查 |
| 部署集合、生成文件、依赖方向 | 重跑对应生成器及 `--check`，构建后运行部署、分层、注入等契约检查及对应 smoke |
| 构建、打包、脚手架或启动脚本 | 先 `pnpm run build`，再运行对应的 `scripts/tests/*.test.mjs`；完整脚本检查用 `pnpm run test:scripts` |
| 插件 tarball / dev loop | `node scripts/build-plugin-tarball.mjs`、`node scripts/test-plugin-local.mjs`、`node scripts/dev.mjs --watch-only` |
| 平台升级或完整交付检查 | `pnpm run release:check`，并核对当前 checkout 与实际加载产物 |
| 版本、tarball、插件安装 | `node scripts/version.mjs <version>`、`pnpm run release:check`、`node scripts/test-plugin-local.mjs`、`node scripts/verify-release-tag.mjs v<version>` |

- `pnpm run test` 运行全部业务单元测试；它不等于覆盖率检查，阈值以 `vitest.config.ts` 为准。测试按 `tsconfig.test-paths.json` 解析源码，不依赖陈旧构建产物。
- `release:check` 包含测试、覆盖率、构建、脚本检查、契约检查和 `node scripts/smoke.mjs applications` / `applications --tooled`，不需要逐项重复执行。它是质量检查，不发布、不部署。
- 浏览器与真实外部动作验证单独执行，使用隔离实例。浏览器验收的部署前提由运行器显式传给 lane 并写入报告；互斥的部署状态不共用同一实例，也不从被测界面反推能力是否存在。
- 浏览器断言使用稳定的业务锚点（`data-*`），准备步骤固定自己的 locale，不以单一语言的 selector 判定部署能力。真实 2× 缩放与读屏仍需人工核对，模拟的缩放等价视口不能当作真实验证。
- 排查启动同时检查插件 warning 和客户端 boot 日志，不能只看宿主退出码。
- 提交前报告修改范围、验证命令和未解决风险。`SKIP`、`UNVERIFIED` 和环境失败不能作为通过。
