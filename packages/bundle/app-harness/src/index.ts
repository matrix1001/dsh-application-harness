/**
 * The application-harness bundle's entry. The bundle is patch-only: cordis.patch.yml
 * rows mount the runtime, store, context, tool bridge, host surface and
 * client shell; the package's own entry intentionally
 * exports no plugin-shaped member (no `name`, no `apply`, no `inject`) — the
 * loader convention is served entirely by the patch rows, so a composition
 * that mounts this entry directly instead of through the patch mounts
 * nothing and fails loud on the first missing service.
 * @module @matrix1001/dsh-application-harness
 */

export {}
