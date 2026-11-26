/**
 * Resolve the stable workspace shared by both launchers.
 *
 * DSH_WORKSPACE wins; otherwise use ~/dsh-workspaces/<profile>. The workspace
 * must stay outside this repository and the installed platform line. Application
 * documents now live in the harness-home SQLite store; .dsh-applications is
 * retained as a legacy directory, including the one-time legacy import files.
 *
 * Inspection never writes. A real launch refuses conflicting directories and
 * requires an interactive confirmation before moving one legacy directory.
 * A failed move preserves the source or names the staging directory holding it.
 * Tests use isolated fixtures, never the user's live directories.
 * @module
 */

import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { PROFILE_DEFAULT } from './deployment-packages.mjs'

/** The world directory name — the `${cwd}/.dsh-applications/…` the bundle patch and `deployment.yml` declare. */
export const WORLD_DIRNAME = '.dsh-applications'

/** The user-level directory the default workspace lives under: `~/dsh-workspaces/<profile>`. */
export const WORKSPACES_DIRNAME = 'dsh-workspaces'

/** The environment variable that names the workspace explicitly (D1's first branch). */
export const WORKSPACE_ENV = 'DSH_WORKSPACE'

/**
 * The environment variable that overrides the legacy-world candidates — the
 * directories a previous entry may have written `.dsh-applications/` to
 * (`path.delimiter`-separated). Unset means the two the documented entries
 * used: this repo and the platform checkout. Empty means "no legacy world
 * anywhere": neither adoption nor the two-world refusal is considered. The
 * isolated instance scripts set it so a verification run can never be the run
 * that adopts (or blocks on) a daily world.
 */
export const LEGACY_ENV = 'DSH_WORKSPACE_LEGACY'

/** The suffix a workspace-in-progress carries; its presence with data means an adoption did not finish. */
export const STAGING_SUFFIX = '.incoming'

/**
 * The file operations the inspection and the adoption use. Injectable for the
 * tests: a fake `rename` that fails with `EXDEV` is how the cross-device branch
 * is reached deterministically on a single-device host.
 * @param {object} [io] - the overrides.
 * @returns the operations.
 */
function opsOf(io = {}) {
  return {
    exists: io.exists ?? existsSync,
    lstat: io.lstat ?? lstatSync,
    readdir: io.readdir ?? readdirSync,
    realpath: io.realpath ?? realpathSync,
    stat: io.stat ?? statSync,
    mkdir: io.mkdir ?? ((path) => mkdirSync(path, { recursive: true })),
    cp: io.cp ?? ((from, to) => cpSync(from, to, { recursive: true, dereference: false })),
    rename: io.rename ?? renameSync,
    remove: io.remove ?? ((path) => rmSync(path, { recursive: true, force: true })),
    rmdir: io.rmdir ?? ((path) => rmdirSync(path)),
  }
}

/**
 * Resolve the workspace this launch's world belongs to: `$DSH_WORKSPACE` when
 * set and non-blank (a relative value resolves against the invocation cwd),
 * else `~/dsh-workspaces/<profile>`.
 * @param {{ profile?: string, env?: Record<string, string | undefined>, home?: string }} [options] - the profile, the environment, and the user's home.
 * @returns {string} the absolute workspace path (not necessarily existing).
 */
export function resolveWorkspace({ profile = PROFILE_DEFAULT, env = process.env, home = homedir() } = {}) {
  const configured = env[WORKSPACE_ENV]
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(home, WORKSPACES_DIRNAME, profile)
}

/**
 * The world directory inside a workspace.
 * @param {string} workspace - the workspace path.
 * @returns {string} `${workspace}/.dsh-applications` (not necessarily existing).
 */
export function worldDirOf(workspace) {
  return join(workspace, WORLD_DIRNAME)
}

/**
 * Whether `path` is a non-empty directory — the one definition of "holds data"
 * (see {@link worldSummary}). Exactly ONE failure is an answer: `ENOENT`, "it is
 * not there" (the directory went away between the probe and the read). Every
 * other failure — permission denied, a path that is not a directory, a broken
 * link — means the question could not be ANSWERED, and answering it with "no
 * world here" would print a NEW WORLD that does not exist and boot into it:
 * precisely the silent empty ledger D4 case 4 forbids. So it throws.
 */
function hasWorldData(path, ops) {
  if (!ops.exists(path)) return false
  try {
    return ops.readdir(path).length > 0
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw new Error(`${path} exists but cannot be inspected (${String(error.message ?? error)}) — refusing to guess whether it holds a world`)
  }
}

/**
 * The world path's SHAPE at the one directory a launch WRITES: absent, a usable
 * directory, or something a world cannot live in. `exists` follows symlinks, so
 * a dangling link reads as "absent" — and "absent" is what had the check lane
 * promise `a launch would create a NEW WORLD` at a path where the launch then
 * refuses (`mkdir` answers ENOENT through a dangling link). A statement about
 * what another path would do has to be true, so the shape is probed with
 * `lstat`, which sees the link itself.
 *
 * A SYMLINK is fine when it resolves to a directory: keeping the world
 * elsewhere on purpose is a layout, not damage. Only shapes nothing can be
 * created in are refused, and they are refused as ERRORS (not as a reported
 * refusal): a broken path is not a data layout somebody chose.
 * @param {string} dir - the world directory path.
 * @param {object} ops - the file operations.
 * @returns {string|undefined} what is wrong with it, or undefined when it is absent or usable.
 */
function worldShapeProblem(dir, ops) {
  let link
  try {
    link = ops.lstat(dir)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw new Error(`${dir} exists but cannot be inspected (${String(error.message ?? error)}) — refusing to guess whether it holds a world`)
  }
  if (link.isDirectory()) return undefined
  if (link.isSymbolicLink()) {
    try {
      return ops.stat(dir).isDirectory() ? undefined : `${dir} is a symlink to something that is not a directory`
    } catch {
      return `${dir} is a dangling symlink (its target does not exist), so no world can be created there`
    }
  }
  return `${dir} is not a directory`
}

/**
 * A directory holding a world, summarized enough for a human to tell which one
 * is live: the entry count, the total bytes and the newest mtime. An empty
 * directory is NOT a world (a run that never wrote leaves an empty
 * `.dsh-applications/`; it must not count as a second world).
 * @param {string} dir - the directory to summarize.
 * @param {object} ops - the file operations.
 * @returns {{entries: number, bytes: number, newest: number|undefined}} the summary.
 */
function worldSummary(dir, ops) {
  let entries = 0
  let bytes = 0
  let newest
  const walk = (current) => {
    for (const entry of ops.readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        entries += 1
        walk(path)
        continue
      }
      entries += 1
      try {
        const stat = ops.stat(path)
        bytes += stat.size
        const at = Math.max(stat.mtimeMs, stat.ctimeMs)
        if (newest === undefined || at > newest) newest = at
      } catch { /* a vanished file is not worth failing the summary over */ }
    }
  }
  try { walk(dir) } catch { /* unreadable: report what was counted */ }
  return { entries, bytes, newest }
}

/** Render a world summary as `N entries, X MB, newest <iso>` for the messages below. */
function describeWorld(dir, ops) {
  const { entries, bytes, newest } = worldSummary(dir, ops)
  const mb = `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  const what = `${entries} ${entries === 1 ? 'entry' : 'entries'}, ${mb}`
  return newest === undefined ? what : `${what}, newest ${new Date(newest).toISOString()}`
}

/**
 * Canonicalize a path for comparison: `resolve` first, so `.`, `..` and a
 * trailing slash can never spell a second directory, then `realpath` of the
 * deepest EXISTING ancestor — a target that does not exist yet still compares
 * equal to its own symlinked parent. Prefix comparison without this is exactly
 * the bug the check below exists for.
 * @param {string} path - the path to canonicalize.
 * @param {object} ops - the file operations.
 * @returns {string} the canonical path.
 */
export function canonicalPath(path, ops = opsOf()) {
  let current = resolve(path)
  const missing = []
  while (!ops.exists(current)) {
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    missing.unshift(basename(current))
    current = parent
  }
  return join(ops.realpath(current), ...missing)
}

/**
 * Today as `YYYYMMDD` in LOCAL time: the stamp in the refusal's by-hand
 * `.keep-…` suggestion is read by the human sitting at this machine, so it
 * must name the day they see, not UTC's.
 * @param {Date} [now] - the clock (injectable for the tests).
 * @returns {string} the stamp.
 */
function localDateStamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
}

/**
 * Whether `child` is `parent` or lives under it. Both sides must be canonical
 * (see {@link canonicalPath}) — this is a comparison, not a resolution.
 * @param {string} parent - the containing directory.
 * @param {string} child - the candidate.
 * @returns {boolean} true when child is parent or under it.
 */
export function isInside(parent, child) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

/**
 * The directories a previous entry may have written the world to. Default: this
 * repo (pre-wrapper launches booted from here). Deduplicated by canonical path.
 * `$DSH_WORKSPACE_LEGACY` replaces the default set (empty = none).
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined>, io?: object }} [options] - the candidates and their override.
 * @returns {Array<{dir: string, label: string}>} the canonical candidates, labelled for the messages.
 */
export function legacyWorldDirs({ repoRoot, env = process.env, io = {} } = {}) {
  const ops = opsOf(io)
  const configured = env[LEGACY_ENV]
  const named = configured === undefined
    ? [{ dir: repoRoot, label: 'this repository' }]
    : configured.split(delimiter).map((dir) => ({ dir, label: 'a named legacy directory' }))
  const seen = new Map()
  for (const { dir: candidate, label } of named) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const dir = canonicalPath(candidate, ops)
    if (seen.has(dir)) {
      const labels = seen.get(dir)
      if (!labels.includes(label)) labels.push(label)
      continue
    }
    seen.set(dir, [label])
  }
  return [...seen].map(([dir, labels]) => ({ dir, label: labels.join(' + ') }))
}

/**
 * The preflight half: the workspace must not live inside this repository. A world there is destroyed by a re-clone, a
 * `git clean -xdf` or a platform update, and `.gitignore` is not a protection
 * mechanism. The judgement is on canonical paths (symlinks, trailing slashes,
 * `.`/`..`), never on string prefixes.
 * @param {{ workspace: string, repoRoot?: string, io?: object }} options - the resolved workspace and the two directories it must stay out of.
 * @returns {Array<{name: string, file: string, hint: string}>} one problem per containing directory (empty = fine).
 */
export function workspaceProblems({ workspace, repoRoot, io = {} }) {
  const ops = opsOf(io)
  const world = canonicalPath(workspace, ops)
  const problems = []
  for (const owner of [
    { dir: repoRoot, label: 'this repository' },
  ]) {
    if (typeof owner.dir !== 'string' || owner.dir === '') continue
    const container = canonicalPath(owner.dir, ops)
    if (!isInside(container, world)) continue
    problems.push({
      name: `workspace inside ${owner.label}`,
      file: world,
      hint: `${WORKSPACE_ENV} resolves to ${world}, which is ${owner.label} (${container}) or below it — workspace files would sit where a re-clone, a \`git clean -xdf\` or a platform update destroys them. `
        + `Point ${WORKSPACE_ENV} at a directory outside both (default: ~/${WORKSPACES_DIRNAME}/<profile>).`,
    })
  }
  return problems
}

/**
 * What a launch WOULD do with this workspace — inspection only, no writes.
 * There is exactly one data-bearing world or the launch refuses: the target's
 * own, or a single legacy one to adopt, or none (= a new world).
 * @param {{ workspace: string, legacyDirs?: Array<{dir: string, label: string}>, io?: object }} options - the workspace and the legacy candidates.
 * @returns {{world: string, holders: Array<{dir: string, label: string, what: string}>, leftovers: string[], action: 'existing'|'migrate'|'new', source?: string, refusal?: string}} the state.
 */
export function inspectWorkspace({ workspace, legacyDirs = [], io = {} }) {
  const ops = opsOf(io)
  const world = worldDirOf(workspace)
  // The TARGET's shape, before anything is decided about it: this is the one
  // path a launch creates, renames into and (for a fresh world) mkdirs. It is
  // checked in BOTH lanes and it THROWS — a broken path is damage, not a layout
  // somebody chose, so the check lane may not report it as a mere UNVERIFIED.
  const shape = worldShapeProblem(world, ops)
  if (shape !== undefined) throw new Error(`${shape} — refusing to guess whether a world lives there; fix or remove it, then launch again`)
  // A LEGACY candidate is deliberately NOT shape-checked: it is only ever a
  // SOURCE, a dangling link there holds no world to lose ({@link hasWorldData}
  // reads it as "no data"), and `moveWorld` cannot reach it because it never
  // becomes a holder. **That asymmetry is load-bearing**: the day a candidate
  // gains any write/delete semantics — even "tidy an empty directory" — this
  // decision has to be redone, because the lenient reading stops being safe.
  const holders = []
  if (hasWorldData(world, ops)) holders.push({ dir: world, label: 'the workspace', what: describeWorld(world, ops) })
  for (const { dir, label } of legacyDirs) {
    const candidateWorld = worldDirOf(dir)
    // A candidate whose world IS the target world is not a second world (the
    // two paths are already the same directory).
    if (canonicalPath(candidateWorld, ops) === canonicalPath(world, ops)) continue
    if (hasWorldData(candidateWorld, ops)) holders.push({ dir: candidateWorld, label, what: describeWorld(candidateWorld, ops) })
  }
  // A staging directory left behind by an interrupted adoption holds a world
  // that is not at either end yet: refuse instead of creating an empty one
  // beside it (D4: never leave half a workspace and boot in it).
  const leftovers = [world + STAGING_SUFFIX].filter((dir) => hasWorldData(dir, ops))
  const target = holders.find((holder) => holder.dir === world)
  const action = target !== undefined ? 'existing' : holders.length === 1 ? 'migrate' : 'new'
  const state = { world, holders, leftovers, action, source: action === 'migrate' ? holders[0].dir : undefined }
  if (leftovers.length > 0) {
    state.refusal = `refusing to launch — a previous adoption of this workspace did not finish:\n`
      + `  - ${leftovers[0]} still holds ${describeWorld(leftovers[0], ops)}\n`
      + `  - the workspace world belongs at ${world}\n`
      + `Finish or undo that move by hand (the data is intact at the path above), then launch again.`
    return state
  }
  if (holders.length > 1) {
    state.refusal = `refusing to launch — ${holders.length} worlds have data and this launcher never merges them or picks one (fail-closed):\n`
      + holders.map((holder) => `  - ${holder.dir}  (${holder.label}, ${holder.what})`).join('\n') + '\n'
      + `Keep ONE of them and move it to the workspace, then launch again:\n`
      + `  mkdir -p ${workspace}\n`
      + `  mv <the world you keep> ${world}\n`
      + `  mv <the other one> <the other one>.keep-${localDateStamp()}\n`
      + `The launcher never merges two histories and never guesses which one is live — see AGENTS.md 「数据与运行环境」.`
  }
  return state
}

/**
 * Bring the workspace to the state a launch needs — and refuse, never guess,
 * when the world could be lost or split.
 *
 * The four fail-closed cases (D4):
 * 1. the target already has a world AND a legacy directory has one → refuse
 *    (no merge, no picking one); the same refusal covers two legacy worlds;
 * 2. exactly one legacy world with data → ask the user to confirm its source
 *    and target in a terminal; adopt only after an explicit yes;
 * 3. no world anywhere → create the empty workspace and say so: this is a NEW
 *    WORLD, not a recovered one;
 * 4. a failed move or a failed path check → throw (the caller exits non-zero)
 *    rather than leaving a half a workspace and booting into an empty ledger.
 *
 * Two callers, one decision: a LAUNCH performs case 1–4 and refuses (throws)
 * when the world would be lost or split, while the CHECK lane (`dryRun`) only
 * looks and gets the refusal back in `refusal` — a world conflict is this
 * machine's data layout, not a defect of the repository under test, so the
 * quality gate reports it as UNVERIFIED instead of failing. The check lane
 * never writes anything, and the launch's hard refusal is unchanged.
 * @param {{ workspace: string, repoRoot?: string, env?: Record<string, string | undefined>, io?: object, dryRun?: boolean, confirmAdoption?: (paths: { source: string, target: string }) => boolean }} options - workspace paths, inspection switch, and the confirmation port (injectable for tests).
 * @returns {{action: 'existing'|'migrate'|'new', workspace: string, world: string, source?: string, refusal?: string, note?: string}} what was done (or, under `dryRun`, what would be; a refusal comes back in `refusal` with every path and the by-hand fix in it).
 * @throws {Error} on a refusal (a real launch) or a failed move; the message names every path involved.
 */
export function prepareWorkspace({ workspace, repoRoot, env = process.env, io = {}, dryRun = false, confirmAdoption = confirmLegacyAdoption } = {}) {
  const ops = opsOf(io)
  const problems = workspaceProblems({ workspace, repoRoot, io: ops })
  if (problems.length > 0) throw new Error(problems.map((problem) => `${problem.name} (${problem.file})\n${problem.hint}`).join('\n'))
  const legacyDirs = legacyWorldDirs({ repoRoot, env, io: ops })
  const state = inspectWorkspace({ workspace, legacyDirs, io: ops })
  if (state.refusal !== undefined) {
    if (!dryRun) throw new Error(state.refusal)
    return { action: state.action, workspace, world: state.world, refusal: state.refusal }
  }
  if (state.action === 'existing') {
    return { action: 'existing', workspace, world: state.world, note: `legacy world: ${state.world} (${state.holders[0].what})` }
  }
  if (dryRun) {
    return state.action === 'migrate'
      ? { action: 'migrate', workspace, world: state.world, source: state.source, note: `would adopt the legacy world at ${state.source} into ${state.world} only after interactive confirmation; an unattended launch refuses` }
      : { action: 'new', workspace, world: state.world, note: `no legacy .dsh-applications world anywhere yet — a launch would create one at ${state.world}` }
  }
  if (state.action === 'migrate' && confirmAdoption({ source: state.source, target: state.world }) !== true) {
    throw new Error(`legacy adoption requires interactive confirmation — nothing was moved:\n  source: ${state.source}\n  target: ${state.world}\nRun the launcher in a terminal and confirm these paths, or move the whole directory explicitly before launching.`)
  }
  ops.mkdir(workspace)
  if (state.action === 'new') {
    ops.mkdir(state.world)
    return {
      action: 'new', workspace, world: state.world,
      note: `NO LEGACY WORLD: no data under ${state.world} and none in the legacy candidates (${legacyDirs.length === 0 ? 'none' : legacyDirs.map((entry) => `${entry.dir} — ${entry.label}`).join('; ')}) — application documents live in the harness-home SQLite store, so this is not an empty-data signal`,
    }
  }
  moveWorld(state.source, state.world, ops)
  return {
    action: 'migrate', workspace, world: state.world, source: state.source,
    note: `adopted the legacy world: ${state.source} → ${state.world} (the old directory is no longer a run path)`,
  }
}

/**
 * Confirm moving a whole legacy directory. Piped input cannot authorize it.
 * The synchronous prompt is shared by both launchers before a child starts.
 */
export function confirmLegacyAdoption({ source, target, input = process.stdin, output = process.stderr,
  open = () => openSync(process.platform === 'win32' ? 'CONIN$' : '/dev/tty', 'r'), read = readSync, close = closeSync }) {
  if (input.isTTY !== true || output.isTTY !== true) return false
  output.write(`发现旧工作区数据。采用会搬移整个目录，不转换格式。\n  来源：${source}\n  目标：${target}\n确认采用请输入 yes，其他输入取消：`)
  const byte = Buffer.alloc(1)
  let answer = ''
  let fd
  try {
    // Node's stdin TTY handle can be nonblocking. A fresh terminal descriptor
    // waits for input without depending on private stream handles.
    fd = open()
    while (answer.length <= 16) {
      if (read(fd, byte, 0, 1, null) === 0) return false
      const char = byte.toString('utf8')
      if (char === '\n') return answer.trim() === 'yes'
      answer += char
    }
  } catch { /* EOF or an unavailable terminal never approves a move. */ }
  finally { if (fd !== undefined) close(fd) }
  return false
}

/**
 * Move one world directory. Two orders, one invariant: at every failure point
 * the world exists in exactly one place — the source, or the staging directory
 * named in the error — never in none of them and never at both ends of a
 * half-finished move.
 * @param {string} source - the legacy world directory.
 * @param {string} target - the workspace world directory.
 * @param {object} ops - the file operations.
 */
function moveWorld(source, target, ops) {
  const staging = target + STAGING_SUFFIX
  // Only ever an EMPTY leftover (a staging directory with data refused earlier).
  ops.remove(staging)
  let held = source
  try {
    // Empty by construction: the target has data only on the `existing` path,
    // which never gets here. `rmdir` (not `rm -r`) so a concurrent writer that
    // landed a byte in between fails the launch instead of losing that byte.
    if (ops.exists(target)) ops.rmdir(target)
    try {
      // Same device: `rename` is a metadata move — no byte is copied and no
      // window exists in which both ends look complete.
      ops.rename(source, staging)
      held = staging
    } catch (error) {
      if (error.code !== 'EXDEV') throw error
      // Cross-device: copy, verify the copy, and only then drop the source.
      try {
        ops.cp(source, staging)
        assertSameTree(staging, source, ops)
      } catch (error) {
        ops.remove(staging)
        throw error
      }
      held = staging
      ops.remove(source)
    }
    ops.rename(staging, target)
  } catch (error) {
    if (held === source) ops.remove(staging)
    throw new Error(`could not move the world into the workspace: ${String(error.message ?? error)}\n`
      + `  the world is intact at ${held} — nothing was deleted; finish the move by hand or fix the cause and launch again`)
  }
}

/**
 * Verify a cross-device copy before its source is dropped: every entry on both
 * sides, recursively, with the same size. A short copy is the one failure mode
 * that would truncate a world silently.
 * @param {string} copy - the copied directory.
 * @param {string} original - the source directory.
 * @param {object} ops - the file operations.
 */
function assertSameTree(copy, original, ops) {
  const tree = (dir, root = dir, out = new Map()) => {
    for (const entry of ops.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) tree(path, root, out)
      else out.set(relative(root, path), ops.stat(path).size)
    }
    return out
  }
  const from = tree(copy)
  const to = tree(original)
  for (const [entry, size] of to) {
    if (!from.has(entry)) throw new Error(`the copy is missing ${entry}`)
    if (from.get(entry) !== size) throw new Error(`the copy of ${entry} is ${from.get(entry)} bytes, the original is ${size}`)
  }
  if (from.size !== to.size) throw new Error(`the copy has ${from.size} entries, the original has ${to.size}`)
}
