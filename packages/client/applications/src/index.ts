/**
 * The applications shell, node half. Pure UI plugin: the empty apply exists so
 * the plugin appears in the host cordis.yml / Loader; the browser half ships
 * via exports["./client"], discovered through the package.json dsh.client
 * declaration.
 * @module @matrix1001/dsh-application-harness-client-applications
 */

/** Host plugin body; the feature is entirely browser-side. */
export function apply(): void {}
