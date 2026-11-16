import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

// The page value-imports only the shared chrome (an inline workspace library);
// the seam list still comes from the manifest so a declared dsh.client.external
// edge, if one is ever added, is externalized by the same rule as its siblings.
export default clientBundle('@matrix1001/dsh-application-harness-inbox-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
