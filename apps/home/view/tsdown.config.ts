import { clientBundle, clientExternalFromPkg } from '../../../packages/client/tsdown.client.ts'

// The page imports only the shell's contract (a peer) and React; the seam list
// comes from the manifest so any future dsh.client.external edge is honoured.
export default clientBundle('@matrix1001/dsh-application-harness-home-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
