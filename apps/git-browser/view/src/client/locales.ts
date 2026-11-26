/** `git-browser` namespace dictionaries (the workbench's full copy). */

import type { ErrorKind } from './model.ts'

/** Dictionary namespace owned by this plugin. */
export const NS = 'git-browser'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'app.name': 'Git 浏览',
  'app.description': '只读浏览本地仓库的工作区、diff 与提交历史。',

  // ── 顶部控制与只读标记 ────────────────────────────────────────────────────
  'view.readonly': '只读',
  'view.path.placeholder': '输入仓库路径',
  'view.path.label': '仓库路径',
  'view.open': '打开',
  'view.changeRepo': '换仓库',
  'view.opening': '打开中…',
  'view.opening.hint': '正在读取仓库状态，请稍候。',
  'view.refresh': '刷新',
  'view.recent': '最近',
  'view.recent.empty': '还没有打开过仓库',
  'view.back': '返回列表',

  // ── 空状态与仓库头 ────────────────────────────────────────────────────────
  'view.empty.title': '打开一个本地仓库',
  'view.empty.body': '输入仓库路径后点“打开”。只读取，不执行任何写操作。',
  'view.retry': '重试',
  'view.history.failed': '提交历史读取失败：{message}',
  'view.history.loadMore': '加载更早的提交',
  'view.history.cap': '仅显示最近 {count} 条',
  'view.diff.failed': 'diff 读取失败：{message}',
  'view.show.failed': '提交详情读取失败：{message}',
  'view.repo.detached': '分离头指针',
  'view.repo.upstream': '{upstream}',
  'view.repo.aheadBehind': '↑ {ahead} · ↓ {behind}',
  'view.repo.dirty': '{count} 个变化',
  'view.repo.clean': '工作区干净',
  'view.repo.lastCommit': '最近提交：{hash} {subject}',

  // ── 页签与工作区 ──────────────────────────────────────────────────────────
  'view.tab.worktree': '工作区',
  'view.tab.history': '提交历史',
  'view.group.staged': '已暂存',
  'view.group.unstaged': '未暂存',
  'view.group.untracked': '未跟踪',
  'view.group.conflict': '冲突',
  'view.worktree.total': '{count} 个变化',
  'view.worktree.note': '点击文件查看 diff',
  'view.worktree.empty': '工作区没有未提交的变化。',

  // ── 文件 diff ─────────────────────────────────────────────────────────────
  'view.diff.subtitle': '{group} · 统一 diff',
  'view.diff.stats': '+{additions} −{deletions}',
  'view.diff.empty': '这个文件没有可显示的 diff。',
  'view.diff.untracked': '未跟踪文件不在 git diff 中：加入索引之后才会显示补丁。',
  'view.diff.binary': '二进制文件：git 不返回文本补丁，这里只标记类型。',
  'view.diff.truncated': '补丁已截断：超过 1 MiB 或 2000 行上限，这里显示的是前缀。',
  'view.diff.loading': '正在读取 diff…',
  'view.diff.readonly': '只读 · 不提供 stage/commit',

  // ── 提交历史与详情 ────────────────────────────────────────────────────────
  'view.history.total': '最近 {count} 个提交',
  'view.history.empty': '还没有可显示的提交。',
  'view.history.select': '选择一个提交查看详情。',
  'view.commit.files': '文件级变化',
  'view.commit.noFiles': '这个提交没有文件级变化。',
  'view.commit.body': '提交说明',
  'view.commit.readonly': '只读 · 提交 {hash}',
  'view.show.loading': '正在读取提交详情…',

  // ── 错误状态（空/非仓库/超时等分开显示） ──────────────────────────────────
  'view.error.notRepo.title': '不是 git 仓库',
  'view.error.notRepo.body': '这个路径不在任何 git 仓库内。换一个仓库路径再试。',
  'view.error.gitMissing.title': '找不到 git',
  'view.error.gitMissing.body': '无法启动 git 可执行文件。确认已安装 git 并在 PATH 中，然后重试。',
  'view.error.pathMissing.title': '路径不存在',
  'view.error.pathMissing.body': '这个路径不存在，或者不是目录。检查后重试。',
  'view.error.timeout.title': '读取超时',
  'view.error.timeout.body': 'git 命令超过时限被终止。确认仓库和磁盘可访问后重试。',
  'view.error.tooLarge.title': '输出过大',
  'view.error.tooLarge.body': 'git 输出超过 1 MiB 上限，无法作为完整列表显示。请缩小范围。',
  'view.error.other.title': '读取失败',
  'view.error.other.body': '这次读取没有成功。可以检查路径后重试。',
  'view.error.permission.title': '缺少本地读取授权',
  'view.error.permission.body': 'Git 浏览需要进程执行能力才能读取本地仓库。在页头“通知”里管理权限，然后重试。',
  'view.error.permission.manage': '管理权限',
  'view.error.detail': '{message}',
  'view.error.diagnostic': '诊断信息',
  'view.restore.fileGone': '上次查看的文件已不在当前工作区，已回到文件列表。',
  'view.restore.commitGone': '上次查看的提交已不在当前历史中。',
  'view.malformed': '结果格式无法解析——host 应用与视图版本可能不一致。',
  'view.cancelled': '读取已取消。',
} as const

/** Dictionary key type. */
export type GitBrowserKey = keyof typeof zh

/** English dictionary (same key set). */
export const en: Record<GitBrowserKey, string> = {
  'app.name': 'Git Browser',
  'app.description': 'Read a local repository’s working tree, diffs and history.',

  'view.readonly': 'Read-only',
  'view.path.placeholder': 'Repository path',
  'view.path.label': 'Repository path',
  'view.open': 'Open',
  'view.changeRepo': 'Change repository',
  'view.opening': 'Opening…',
  'view.opening.hint': 'Reading the repository status…',
  'view.refresh': 'Refresh',
  'view.recent': 'Recent',
  'view.recent.empty': 'No repository opened yet',
  'view.back': 'Back to list',

  'view.empty.title': 'Open a local repository',
  'view.empty.body': 'Enter a repository path and choose Open. This page only reads; it never writes.',
  'view.retry': 'Retry',
  'view.history.failed': 'Could not read the commit history: {message}',
  'view.history.loadMore': 'Load older commits',
  'view.history.cap': 'Only the latest {count} commits are shown.',
  'view.diff.failed': 'Could not read the diff: {message}',
  'view.show.failed': 'Could not read the commit: {message}',

  'view.repo.detached': 'Detached HEAD',
  'view.repo.upstream': '{upstream}',
  'view.repo.aheadBehind': '↑ {ahead} · ↓ {behind}',
  'view.repo.dirty': '{count} change(s)',
  'view.repo.clean': 'Working tree clean',
  'view.repo.lastCommit': 'Latest: {hash} {subject}',

  'view.tab.worktree': 'Working tree',
  'view.tab.history': 'History',
  'view.group.staged': 'Staged',
  'view.group.unstaged': 'Unstaged',
  'view.group.untracked': 'Untracked',
  'view.group.conflict': 'Conflicted',
  'view.worktree.total': '{count} change(s)',
  'view.worktree.note': 'Choose a file to see its diff',
  'view.worktree.empty': 'No uncommitted change in the working tree.',

  'view.diff.subtitle': '{group} · unified diff',
  'view.diff.stats': '+{additions} −{deletions}',
  'view.diff.empty': 'This file has no diff to show.',
  'view.diff.untracked': 'An untracked file is outside git diff: it shows a patch only after it joins the index.',
  'view.diff.binary': 'Binary file: git returns no text patch, so this page only marks the type.',
  'view.diff.truncated': 'The patch was cut at the 1 MiB / 2000-line cap; this is a prefix.',
  'view.diff.loading': 'Reading the diff…',
  'view.diff.readonly': 'Read-only · no stage/commit',

  'view.history.total': 'Latest {count} commit(s)',
  'view.history.empty': 'No commit to show yet.',
  'view.history.select': 'Choose a commit to see its detail.',
  'view.commit.files': 'File statistics',
  'view.commit.noFiles': 'This commit records no file-level change.',
  'view.commit.body': 'Commit message',
  'view.commit.readonly': 'Read-only · commit {hash}',
  'view.show.loading': 'Reading the commit…',

  'view.error.notRepo.title': 'Not a git repository',
  'view.error.notRepo.body': 'That path is not inside a git repository. Try another repository path.',
  'view.error.gitMissing.title': 'git not found',
  'view.error.gitMissing.body': 'The git executable could not be started. Install git on PATH and retry.',
  'view.error.pathMissing.title': 'Path not found',
  'view.error.pathMissing.body': 'That path does not exist, or is not a directory. Check it and retry.',
  'view.error.timeout.title': 'Read timed out',
  'view.error.timeout.body': 'The git command passed its deadline and was terminated. Check the repository and disk, then retry.',
  'view.error.tooLarge.title': 'Output too large',
  'view.error.tooLarge.body': 'The git output passed the 1 MiB cap and cannot be shown as a complete list. Narrow the scope.',
  'view.error.other.title': 'Read failed',
  'view.error.other.body': 'This read did not succeed. Check the path and retry.',
  'view.error.permission.title': 'Local read permission missing',
  'view.error.permission.body': 'Git browsing needs the process capability to read this repository. Manage it from the Notifications control in the page header, then retry.',
  'view.error.permission.manage': 'Manage permissions',
  'view.error.detail': '{message}',
  'view.error.diagnostic': 'Diagnostics',
  'view.restore.fileGone': 'The file you were viewing is gone from this worktree; showing the file list.',
  'view.restore.commitGone': 'The commit you were viewing is no longer in this history.',
  'view.malformed': 'The result shape could not be read — the host application and this view may be out of step.',
  'view.cancelled': 'The read was cancelled.',
}

/** One error kind's static copy (the dynamic detail is appended by the page). */
export const ERROR_COPY: Record<ErrorKind, { title: GitBrowserKey; body: GitBrowserKey }> = {
  'not-repo': { title: 'view.error.notRepo.title', body: 'view.error.notRepo.body' },
  'git-missing': { title: 'view.error.gitMissing.title', body: 'view.error.gitMissing.body' },
  'path-missing': { title: 'view.error.pathMissing.title', body: 'view.error.pathMissing.body' },
  timeout: { title: 'view.error.timeout.title', body: 'view.error.timeout.body' },
  'output-too-large': { title: 'view.error.tooLarge.title', body: 'view.error.tooLarge.body' },
  permission: { title: 'view.error.permission.title', body: 'view.error.permission.body' },
  other: { title: 'view.error.other.title', body: 'view.error.other.body' },
}
