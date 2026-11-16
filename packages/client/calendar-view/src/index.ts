/**
 * calendar application page plugin, node half. Pure UI plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader; the browser
 * half ships via exports["./client"], discovered through the package.json
 * dsh.client declaration.
 * @module @matrix1001/dsh-application-harness-calendar-view
 */

/** Host plugin body — no host-side behavior for this source plugin. */
export function apply(): void {}
