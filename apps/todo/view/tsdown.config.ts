import { clientBundle, clientExternalFromPkg } from '../../../packages/client/tsdown.client.ts'

// The view value-imports the inlined static library `client-object-reference`
// (listed in the deployment's `client.inlined`) and nothing from another
// bundle; the seam is read from the manifest (one source) so the purity gate
// externalizes a declared dsh.client.external edge if an infrastructure value
// import is added later (inject stays informational — not a build seam).
export default clientBundle('@matrix1001/dsh-application-harness-todo-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
