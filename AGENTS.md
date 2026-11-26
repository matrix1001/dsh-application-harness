# AGENTS.md

Application Harness 是 DeepSeek Harness 的应用运行与互联层。入口：[README](README.md) 看安装和使用；[架构总览](docs/ARCHITECTURE.md) / [实现细节](docs/architecture/11-实现与验收.md) 看设计与实现；[应用开发指南](docs/APPLICATION_DEVELOPMENT.md) 看应用接入；[文档地图](docs/README.md) 是索引。

## 开始之前

- 使用中文，先说明要做什么、为什么，再改代码。设计问题逐条讨论，推荐并说明理由后等待用户确认。
- 修改前阅读相关文档、源码和测试；不回滚用户已有的无关修改，不使用破坏性 Git 命令。
- 架构文档是已确认的设计依据。实现与设计不一致时明确差异并修复，不把目标当作已实现，也不为迁就旧实现改回设计。
- 历史通过 Git 查询。验证结果和修改范围写在对话或提交说明中，不新增计划、待办或历史归档。

## 常用命令

```sh
node scripts/deps.mjs               # 安装依赖；store 在 .pnpm-store/
pnpm run dev                        # 构建并启动 Web，串行重建 host/client
pnpm run typecheck                  # 类型检查（npm 平台线）
pnpm run test                       # 业务单元测试
pnpm run test:coverage              # 覆盖率：核心包 100% + 全局地板 + 改动行
pnpm run check:docs                 # 文档链接、锚点、索引、命令名与字数门禁
pnpm run build                      # 构建（本机即发布构建）
pnpm run release:check              # 发布前完整检查
node scripts/test-plugin-local.mjs  # 自包含 tarball 安装验收
```

平台升级、发布和安装的完整命令见[开发、安装与发布操作](docs/DEVELOPMENT.md)。

## 仓库地图

- `packages/application/*`：运行时、host bridge、存储、工具和 HTTP。
- `packages/client/*`：应用区 shell、视图和共享界面。
- `apps/*/{host,view}`：笔记、待办、收件箱、Git 浏览等内置应用。
- `packages/bundle/app-harness`：bundle、部署声明和 locale。
- `packages/typert/protocol`：跟随平台线的 vendored 协议壳。
- `scripts/`：构建、发布、验收和契约脚本；`docs/`：设计与操作文档；`.platform-src/`：从安装线生成的测试源码夹具（gitignored，不手改）。
- `skills/application-harness-maintenance/`：本仓维护审查 skill；只作为仓库文件，不自动安装到 DSH profile。
- `skills/application-harness-app-development/`：面向应用作者的接入 skill；同样只作为仓库文件。

## 修改约束

- 先改核心类型和契约，再改调用方和客户端；同一事实只定义一次。
- 跨 workspace 包源码导入必须有完整 TypeScript 项目引用；客户端运行时依赖遵守平台模块与声明规则；跨插件值协作走平台服务。
- 复用平台能力前核对实际契约与测试，不复制平台实现，不为适配接口虚构会话；应用身份和权限接入留在本仓。
- 不序列化或克隆运行中的服务/上下文对象，只读取需要的字段。
- 同一规则只在所属文档完整定义，其他文档保留链接；任务指南和操作手册可以用操作步骤复述规则，但不重新定义。README 和应用指南只写已实现行为，示例对应当前源码。不新增包 README、翻译副本、独立计划或历史归档；第三方文档和许可证保留。

## 环境与数据保护

- 依赖使用 `node scripts/deps.mjs`；pnpm store 在 `.pnpm-store/`，npm cache 在 `tmp/npm-cache`；临时材料放 `tmp/`。
- 一个 `DSH_HOME` 只由一个宿主写入。验证必须隔离家目录、profile、工作区和端口，不使用日常实例。
- 工作区由 `scripts/workspace.mjs` 解析：`DSH_WORKSPACE` 优先，否则 `~/dsh-workspaces/<profile>`；不得位于仓库内。
- 数据路径以[部署声明](packages/bundle/app-harness/deployment.yml)为准，不在模块级增加隐式路径；不因旧应用删除而清理数据。
- `DSH_WORKSPACE_LEGACY` 的旧数据搬移必须交互展示来源和目标，由用户输入 `yes`；非交互或未确认时拒绝，两个位置都有数据时拒绝合并。
- `pnpm run clean` 默认只清理构建产物；业务数据清理必须显式授权目标路径，工作区数据只能通过 `--purge-data --workspace <dir>` 指定。

Git 配置污染时在命令前加 `GIT_CONFIG_COUNT=0`；pnpm shim 无法执行时使用真实 pnpm 二进制。这些是环境排障，不改变验证结论。

## 分支、发布与推送

- `dev`：本地开发线，保留完整历史，版本 `X.Y.Z-dev.N`；不推送。
- `master`：公开快照线，每个正式版本一个 snapshot commit；不直接在 master 开发；CI 和 README badge 以它为准。
- tag `vX.Y.Z` 必须指向公开快照，且 bundle 版本一致；不能打在 dev commit 上。
- 发布物是 GitHub Release 上的单个自包含 tarball：bundle 的运行时 row 包以嵌套依赖进入 tarball，平台包保持 peer；全部可发布包同版本。
- 安装验收必须使用隔离的 `DSH_HOME`、profile 和端口；tarball 不运行作者构建脚本。

### 推送安全

- 任何 push/tag 前报告目标 ref、commit、tag、版本、检查结果和命令，**等待用户明确确认后才执行**；用户说“推送”只授权当前这一次，不延续到 tag、force push 或下一次。
- 先推 `master`，CI 全绿后再单独确认并推 tag；tag 会触发 Release。
- 只使用显式 refspec；禁止推 `dev`、`git push --all`、`git push --mirror`。
- 已发布的历史和 tag 不得重写；仅尚未发布的快照修正可用 `--force-with-lease`，且必须先说明原因并取得确认。
- 公开快照必须排除 `.claude/`、`.agents/`、`.codex/`、`tmp/`、`dist/` 等本地或生成内容。

完整快照生成、推送前检查和发布流程见[开发、安装与发布操作](docs/DEVELOPMENT.md)。

## 平台与生成文件

- 平台只跟 npm 已发布版本：checkout 不参与日常开发，Typert generator、类型、测试源码都来自 `node scripts/deps.mjs` 安装的那一版。只支持最新发布版本，新版本发布后用 `node scripts/platform-line.mjs --set <version>` 升级。
- `packages/typert/protocol/src/` 不手改；`platform-line --set` 从安装的 protocol 包刷新，唯一本地归一化是去掉 Cordis Context augmentation。
- `.platform-src/` 是 `scripts/sync-platform-fixture.mjs` 从 `node_modules` 生成的客户端测试夹具（平台 client 入口是模块表 bundle，Node 里只能读源码）；`deps` 与 `--set` 自动刷新，`--check` 进 `release:check`。
- `packages/bundle/app-harness/deployment.yml` 是部署声明真源；改应用行后运行 `node scripts/generate-bundle-patch.mjs` 和 `--check`，不手改生成段。
- 使用 `scripts/setup.mjs` 刷新 profile；不覆盖平台维护的用户设置、插件依赖和构建批准。
- host/client 改动必须重建；client 重建后手动刷新，host 改动重启 dev。`--hmr` 是实验性 host HMR，不作为稳定契约。

## 验证

按改动面选检查，不默认跑全量。

| 改动 | 检查 |
|---|---|
| 文档 | `pnpm run check:docs`；核对源码、命令与事实，链接和锚点由脚本保证 |
| 业务/客户端 | `pnpm run typecheck`、相关测试；涉及界面跑 `pnpm run test:browser`（隔离实例）并人工核对 |
| 公共 API/协议 | 对应类型、调用与协议测试，更新必要的 API/协议快照 |
| 部署/生成/依赖方向 | 重跑生成器和 `--check`，构建后跑部署、分层、注入和契约测试 |
| 构建/脚本/启动 | 先 `pnpm run build`，再跑对应 `scripts/tests/*.test.mjs`；完整用 `pnpm run test:scripts` |
| 平台升级/完整交付 | `pnpm run release:check`，核对实际加载产物 |
| 版本/tarball/安装 | `release:check`、`test-plugin-local`、`verify-release-tag` |

测试分层：`packages/application/**/src` 逐文件 100%；全局地板 98/98/96/94（lines/statements/functions/branches），非核心文件另守 97/97/95/92；新代码改动行由 `pnpm run test:diff` 按基准聚合检查（当前阈值 90%）；未覆盖位置用 `pnpm run coverage:uncovered` 定位；`/* v8 ignore */` 必须带 `-- 理由`，未覆盖的行先判断是否该存在。UI 行为另由浏览器冒烟覆盖（见 `tests/browser/`）。

`release:check` 是质量检查，不发布、不部署；它已包含测试、覆盖率、构建、脚本、契约和 smoke，不重复逐项跑。浏览器验收使用隔离实例和稳定 `data-*` 锚点，固定 locale；真实 2× 缩放和读屏仍需人工核对。启动排查同时看插件 warning 和客户端 boot 日志，不能只看宿主退出码。提交前报告修改范围、验证命令和未解决风险；`SKIP`、`UNVERIFIED` 和环境失败不能当作通过。

## 编辑本文件

- AGENTS 只放修改前必须知道的规则、命令和入口；详细过程放 docs，能由测试或生成器机械保证的不写成长段说明。
- 新规则必须有真实失败案例或明确安全风险；优先删除、合并和链接，不新增章节。
- 保持中文；`CLAUDE.md` 仅作为本文件的链接。
