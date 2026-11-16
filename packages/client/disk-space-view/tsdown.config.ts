import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

// The page inlines the shared chrome library (TabBar); the seam is read from
// the manifest so an infrastructure value import declared later is
// externalized without a second source of truth.
export default clientBundle('@matrix1001/dsh-application-harness-disk-space-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
