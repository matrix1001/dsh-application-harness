# 上手

> 类型：上手教程。目标是在本机跑起来、改一行看到效果、知道改完去哪验证；当前实现与差异见 [11 §5](architecture/11-实现与验收.md#5-当前未完成与边界)。

这篇写给第一次在本仓开发或维护的人。照做之后应当能打开 Web 界面，看到部署声明里的内置应用，并且知道一次改动要跑哪些检查。

## 1. 前置

| 需要 | 版本或来源 | 怎么确认 |
|---|---|---|
| Node.js | `^24.22.3 || >=26.13.1`（见 [.nvmrc](../.nvmrc)） | `node -v` |
| pnpm | `11.22.0`（见 `packageManager`） | `pnpm -v` |
| DSH 平台包 | npm 最新发布版本（当前 `0.2.3-alpha.2`），由 `node scripts/deps.mjs` 安装 | `node scripts/platform-line.mjs --check` |

不需要全局安装 `dsh`：`pnpm start` 运行的是 `node_modules` 里安装的那一版 dsh。`setup --launch` 已废弃。

## 2. 最短路径

首次运行使用独立的家目录和工作区，避免写到日常实例：

```bash
export DSH_HOME="$HOME/.dsh-application-harness-dev"
export DSH_WORKSPACE="$HOME/dsh-workspaces/application-harness-dev"

node scripts/deps.mjs    # 安装依赖，store 落在 .pnpm-store/
node scripts/setup.mjs   # 构建工作区，生成/刷新 application-harness profile
pnpm start               # preflight 后启动，默认打开 http://127.0.0.1:3080
```

首次构建需要几分钟。成功时浏览器打开 Web 界面，侧栏应用区列出部署声明里的内置应用。

## 3. 这几个命令分别在做什么

| 命令 | 做什么 | 什么时候用 |
|---|---|---|
| `node scripts/deps.mjs` | `pnpm install` 加工作区本地 store | 拉取代码后、依赖变化后 |
| `node scripts/setup.mjs` | 构建工作区，写入 profile 的 `file:` 链接并安装其依赖 | 第一次、包结构变化后 |
| `pnpm start` | 解析运行来源与工作区，检查客户端产物，再启动 dsh | 日常启动 |
| `pnpm dev` | 构建、启动、监听源码变化并串行重建 | 持续开发；client 改动刷新浏览器，host 改动重启 dev |
| `pnpm start --build` | 先构建再启动，跳过手动 build | 改了源码但不想开 watch |
| `pnpm start --no-setup` | profile 缺失时直接失败，不自动补建 | 验证“全新环境”行为 |

参数原样转给 dsh 时放在 `--` 后面，例如 `pnpm start -- --no-open --port 3200`。`--hmr` 是实验性的宿主 HMR，不作为稳定契约。

## 4. 平台版本

本仓只依赖 npm 已发布的 DSH 版本（当前 `0.2.3-alpha.2`，记在[部署声明](../packages/bundle/app-harness/deployment.yml)的 `platform.declaredLine`）：

- `node scripts/deps.mjs` 把平台包装进 `node_modules`；类型、Typert generator、运行时和测试源码都来自这一份安装，不需要 checkout，也不需要全局 `dsh`。
- 新版本发布后用 `node scripts/platform-line.mjs --set <version>` 升级：校验该版本（含直接依赖的平台包）已发布、改写 pins/engines/mirror、安装、刷新 Typert 壳和 `.platform-src` 测试夹具；随后按 `pnpm run typecheck` / `pnpm run test` 的失败适配。
- 只支持最新发布版本，`engines.dsh` 是精确版本。

`node scripts/platform-line.mjs --check` 核对声明、pin、engines、镜像清单和壳是否一致，并在 npm 有更新版本时打印提示。

## 5. 改一行，看到效果

以笔记应用为例：

1. 在 `pnpm dev` 运行期间，改 `apps/notes/view/src/client/NotesView.tsx` 里的一处文案。
2. 等终端打印重建完成，刷新浏览器，文案应已更新；client-hmr 是否自动刷新取决于平台 web profile，不要依赖它。
3. 改宿主侧代码（`packages/application/*`）后重启 `pnpm dev`，再验证同一路径。
4. 跑对应的测试（例如 `pnpm exec vitest run apps/notes/view/tests`）。

看不到变化时先确认改的是不是当前加载的产物：构建是否成功、浏览器是否刷新、profile 是否指向本仓（见第 7 节）。

## 6. 改完跑什么

| 改动面 | 最低检查 |
|---|---|
| 文档 | `pnpm run check:docs` |
| 业务/客户端 | `pnpm run typecheck`、相关测试；界面另做浏览器验收 |
| 公共 API/协议 | `pnpm run typecheck`、对应测试，更新必要快照 |
| 部署/生成/依赖方向 | 重跑生成器与 `--check`，再跑契约测试 |
| 构建/脚本/启动 | `pnpm run build` 后跑 `scripts/tests/*.test.mjs` |
| 发布前 | `pnpm run release:check` |

完整规则和“不能当作通过”的情形见 [AGENTS 验证](../AGENTS.md#验证)。

## 7. 常见失败

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动前报 “installed platform CLI … is missing” | 依赖没装或安装不完整 | 跑 `node scripts/deps.mjs` |
| 报 profile 不存在 | 首次运行没建 profile | 先 `node scripts/setup.mjs`；不要用 `--no-setup` 跳过 |
| 页面空白或 boot 失败 | 客户端产物缺失或过期 | `pnpm run build` 后重启；同时看浏览器 console 的 boot 日志 |
| 改了依赖或包结构后启动异常 | profile 的链接过期 | 重跑 `node scripts/setup.mjs` |
| 端口 3080 被占用 | 已有实例在跑 | `pnpm start -- --port 3200`，并确认用的是独立实例 |
| 进程退出码为 0 但启动不完整 | 启动问题不总以退出码表达 | 同时看宿主插件 warning 和客户端 boot 日志 |

## 8. 下一步

- 写一个应用：[应用开发指南](APPLICATION_DEVELOPMENT.md)。
- 查符号、错误码和宿主状态文件：[REFERENCE](REFERENCE.md)。
- 了解日常开发、安装和发布：[操作手册](DEVELOPMENT.md)。
- 改代码前必须知道的规则：[AGENTS](../AGENTS.md)。
