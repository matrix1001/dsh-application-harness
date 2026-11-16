import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

// The view value-imports nothing from other bundles today, but the seam is
// read from the manifest (one source) so the purity gate externalizes a
// declared dsh.client.external edge if an infrastructure value import is
// added later (inject stays informational — not a build seam).
export default clientBundle('@matrix1001/dsh-application-harness-usage-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
