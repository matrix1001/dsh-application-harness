# 开发、安装与发布操作

> 类型：操作手册。设计与不变量见 [交付设计](architecture/12-开发安装与发布.md)，当前实现与差异见 [11 §5](architecture/11-实现与验收.md#5-当前未完成与边界)，工程约束见 [AGENTS](../AGENTS.md)。

## 1. 环境隔离

日常开发使用 `application-harness` profile 和默认 `~/.dsh`。从源码开发、验证 Release 或验收候选构建时，必须另用独立的 `DSH_HOME`、工作区、profile 和端口，不读写日常实例。

| 用途 | DSH_HOME | 工作区 |
|---|---|---|
| 日常开发 | 默认 `~/.dsh` | `~/dsh-workspaces/application-harness` |
| Release 安装/验收 | 独立，例如 `~/.dsh-application-harness-release` | 独立目录 |
| 自动安装验收 | `tmp/plugin-e2e/home` | 由 `test-plugin-local` 管理 |

```bash
export DSH_HOME="$HOME/.dsh-application-harness-release"
export DSH_WORKSPACE="$HOME/dsh-workspaces/application-harness-release"
```

普通用户没有源码实例时可以使用默认 `DSH_HOME`；维护者不要把 Release 安装和 `pnpm dev` 混在同一 `DSH_HOME`。

## 2. 日常开发

```bash
node scripts/deps.mjs
pnpm run dev
pnpm run dev --watch-only
pnpm run typecheck
pnpm run test
pnpm run test:coverage               # vitest + 核心包 100% + 地板 + 改动行
pnpm run test:diff                   # 只查本次改动行（基准 origin/master）
pnpm run coverage:uncovered          # 打印未覆盖的 file:line
pnpm run test:browser                # 隔离实例的浏览器冒烟（Playwright）
pnpm run build
```

`pnpm run build` 就是发布构建：本机、CI 和 tarball 使用同一条 npm 平台线，没有第二条构建。发布前用 `node scripts/test-plugin-local.mjs` 做 tarball 安装验收。

`pnpm dev` 串行重建 host/client；client 改动后手动刷新，host 改动默认重启。`--hmr` 是实验性 host HMR overlay，不作为稳定契约，也不提供应用内重载按钮或 route。

依赖或包结构变化后重新运行 `node scripts/setup.mjs`，不要带着半坏 profile 启动。日常开发的 profile 与 Release 安装隔离规则见第 1 节。

### 平台升级

```bash
node scripts/platform-line.mjs --check        # 三处一致 + npm 是否有更新的发布版本
node scripts/platform-line.mjs --set <version>  # 唯一升级入口：校验已发布、改写、安装、刷新壳
pnpm run typecheck && pnpm run test           # 失败就是适配清单
pnpm run release:check
```

升级是一个显式动作，不自动巡检；`--check` 在 npm 有新版本时打印提示。`--set` 结束后会自动重装依赖、刷新 Typert 壳和 `.platform-src/` 测试夹具（来源是安装的 npm 包，不是 checkout）。规则见[开发、安装与发布 §3.4](architecture/12-开发安装与发布.md#34-平台升级适配)。

`--set` 不自动处理这些手工面：测试夹具包清单与 `tsconfig.test-paths.json`、非 `dsh*`
的框架代际 pin（cordis 家族、cosmokit、schemastery）、Node 版本面（engines、`.nvmrc`、
CI、README/START），以及示例组合里的平台行。前三类都有门禁与安装线比对；示例组合
仍按 typecheck/smoke 的失败清单逐项核对。壳 `package.json` 的依赖与 peer 现在也与
安装的 protocol 包比对。

## 3. 安装 Release

维护者先按第 1 节设置独立 `DSH_HOME`。普通用户如果没有源码实例，可以省略 `DSH_HOME` 覆盖。

已发布资产以 tarball 内 `deployment.yml` 的 `platform.declaredLine` 为准：Release `0.1.1` 与 `dev` 源码线同为 `0.2.3-alpha.2`；上一版 `0.1.0` 是 `0.2.2-rc.2`，不要混装。

```bash
# 创建独立 profile（只需一次）
dsh --profile application-harness --from-default-profile web --dump-config

# 校验 Release 资产（Linux）
curl -fLO https://github.com/matrix1001/dsh-application-harness/releases/download/v0.1.1/matrix1001-dsh-application-harness-0.1.1.tgz
curl -fLO https://github.com/matrix1001/dsh-application-harness/releases/download/v0.1.1/matrix1001-dsh-application-harness-0.1.1.tgz.sha256
sha256sum -c matrix1001-dsh-application-harness-0.1.1.tgz.sha256

# 安装并启动
dsh plugin --profile application-harness add \
  https://github.com/matrix1001/dsh-application-harness/releases/download/v0.1.1/matrix1001-dsh-application-harness-0.1.1.tgz
dsh --profile application-harness
```

macOS 用 `shasum -a 256 -c` 核对同名校验文件。

安装后应核对 bundle 版本、`locale/en.json`，以及 Release 说明/资产中的嵌套自有包清单。
profile 的 `dsh.profile.bundles` 应包含 `@matrix1001/dsh-application-harness`。不同版本的应用与包集合不同，不要用当前 dev 文档的数量核对已发布资产。升级是换新版本的 asset URL 再执行 `dsh plugin add`；卸载用 `dsh plugin --profile application-harness remove @matrix1001/dsh-application-harness`，业务数据不会随卸载删除，默认位于 `$DSH_HOME/application-harness/`。

安装的是预构建 tarball；不运行作者构建脚本，也不需要 scope registry 或 `allowBuilds`。插件执行本机代码，只安装可信 Release。

## 4. 发布

发布前在 `dev` 上把版本设为正式版本并提交：

```bash
node scripts/version.mjs 0.1.1
pnpm run release:check
pnpm run build
node scripts/test-plugin-local.mjs
node scripts/verify-release-tag.mjs v0.1.1
```

这次提交同时更新 README 与操作手册中的 Release asset URL 和 `.sha256` 文件名，公开快照会带上它们。

从正式版本的 release tree 生成公开快照，不能用当前 `-dev.N` 的 tree：

```bash
git worktree add --detach tmp/public-snapshot <release-commit>
tree=$(git -C tmp/public-snapshot write-tree)
commit=$(git commit-tree "$tree" -p master -m "Release 0.1.1")
git branch -f master "$commit"
git tag -a "v0.1.1" -m "v0.1.1" "$commit"
git worktree remove tmp/public-snapshot --force
```

首次快照没有父 commit；本仓已经有 `master` 后按上面 `-p master` 追加，公开历史不重写。快照不得包含 `.claude/`、`.agents/`、`.codex/`、`tmp/`、`dist/` 等本地或生成内容。

### 推送前检查

任何 push/tag 前必须完成并报告：

1. `git status --short` 干净；审查 diff，确认没有凭据、个人路径、临时文件或不该公开的配置。
2. `git ls-tree -r --name-only master` 不含 `.claude`、`.agents`、`.codex`、`tmp`、`dist` 等；`.gitignore` 仍排除它们。
3. `git diff --name-only master dev` 只有预期发布差异；`master` 与 tag 指向的 bundle 版本一致。
4. 运行 `node scripts/verify-release-tag.mjs vX.Y.Z`、`pnpm run release:check`、`node scripts/test-plugin-local.mjs`；完整发布三项都要。Tag workflow 会校验 tag 精确等于 `origin/master`；本地报告时也要核对。
5. 报告精确 ref、commit、tag、版本、验证结果和命令；**等待用户明确确认后才执行**。一次确认只授权当前 push，不延续到 tag、force push 或下一次。
6. 先推 `master` 并等 CI 全绿，再单独确认并推 tag；tag 会触发 Release。
7. 只使用显式 refspec：`git push origin master`、`git push origin vX.Y.Z`；禁止 `git push --all`、`--mirror`、推 `dev`。已发布历史和 tag 不重写；未发布快照修正才可用 `--force-with-lease`，且先说明并取得确认。
8. 推送后核对远端 refs、CI、Release asset 和 sha256；失败时停止，不继续推后续 ref。

## 5. 发布后验收

```bash
git ls-remote origin refs/heads/master refs/tags/vX.Y.Z
sha256sum -c matrix1001-dsh-application-harness-X.Y.Z.tgz.sha256
dsh plugin --profile application-harness add <release-asset-url>
dsh --profile application-harness
```

新版本安装后至少检查该 Release 说明列出的应用、笔记/待办的存储授权和一次本地保存；没有真实 API Key 时只验证安装、启动和本地应用，不把模型调用当作已验收。
