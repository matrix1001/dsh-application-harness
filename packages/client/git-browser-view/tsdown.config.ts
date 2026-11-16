import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

// The page's shared chrome (TabBar) is the inlined workspace static library;
// the seam is read from the manifest (one source), so the purity gate
// externalizes a declared dsh.client.external edge only if an infrastructure
// value import is ever added (inject stays informational — not a build seam).
export default clientBundle('@matrix1001/dsh-application-harness-git-browser-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
