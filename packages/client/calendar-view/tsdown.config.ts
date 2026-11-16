import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

// The view value-imports nothing from other bundles except the inlined chrome
// library; the seam is read from the manifest so a declared dsh.client.external
// edge is externalized if one is added later (inject stays informational).
export default clientBundle('@matrix1001/dsh-application-harness-calendar-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
