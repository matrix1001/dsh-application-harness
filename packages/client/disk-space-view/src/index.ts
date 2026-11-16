/**
 * Disk-space view plugin, node half. Pure UI plugin: the empty `apply` exists
 * so the plugin appears in the host Loader tree; the browser half ships via
 * `exports["./client"]`, discovered through the package.json `dshClient`
 * declaration.
 * @module @matrix1001/dsh-application-harness-disk-space-view
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply(): void {}
