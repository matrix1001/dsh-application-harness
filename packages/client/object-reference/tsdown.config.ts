import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { CLIENT_EXTERNALS, clientLibraryConfig, cssModulesPlugin } from '../tsdown.client.ts'

// The shared world-view object-reference is a browser-static library, not a plugin: no
// dsh.client declaration, no profile row. Its lib product is inlined into
// every consuming client bundle (the bundle purity gate allowlists the inline
// edge — "silence means a private copy", AGENTS.md), so the css-module
// transform runs here the same way it does for a client bundle. The library
// builds only once the client tsc aggregate has emitted `lib/types`: the
// root tsdown inside `typecheck` runs before `tsc -b tsconfig.client.json`,
// so it skips this package and the later passes (build / a post-tsc client
// rebuild) pick it up.
export default (): UserConfig[] => {
  if (!existsSync(fileURLToPath(new URL('lib/types/index.js', import.meta.url)))) {
    return [{ entry: '' }]
  }
  return [clientLibraryConfig('@matrix1001/dsh-application-harness-client-object-reference', ['lib/types/index.js'], {
    plugins: [cssModulesPlugin('@matrix1001/dsh-application-harness-client-object-reference')],
    // The platform baseline is a shared singleton, never a private copy: a
    // component that renders through the module-table react-dom must call its
    // hooks on the SAME react instance (react-dom sets every hook's dispatcher
    // on the react module it was loaded against). Bundling react here would
    // make every consumer carry a second instance whose dispatcher stays null
    // — TabBar's `useRef` died with
    // "TypeError: Cannot read properties of null (reading 'useRef')" the first
    // time a world view mounted it. Keep the seed entries external so the
    // consumer's own deps.neverBundle rebinds them to the loader module table.
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
  })]
}
