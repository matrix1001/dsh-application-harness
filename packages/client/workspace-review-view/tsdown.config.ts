import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

export default clientBundle('@matrix1001/dsh-application-harness-workspace-review-view', ['lib/types/index.js'], {
  clientExternal: clientExternalFromPkg(import.meta.url),
})
