import { clientBundle, clientExternalFromPkg } from '../tsdown.client.ts'

export default clientBundle('@matrix1001/dsh-application-harness-client-applications', ['lib/types/index.js'], {
  // The bundle's module-table requests, read from the manifest's single
  // source (`dsh.client.external`); `inject` stays informational. The
  // generated `applications` Remote contribution is not a module-table
  // request — `tsdown.client.ts` classifies the host bridge's `/remote`
  // subpath as an inline-safe GENERATED_REMOTE artifact, and the shell mounts
  // it through `ctx.remote.$mount`.
  clientExternal: clientExternalFromPkg(import.meta.url),
})
