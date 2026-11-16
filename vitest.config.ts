import ts from 'typescript'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * Transform standard TypeScript decorators before Vite's default parser sees
 * source files (mirrors the harness repo's vitest.shared.ts plugin).
 * @returns a pre-transform Vite plugin shared by source-mode test configurations.
 */
function standardDecoratorPlugin() {
  return {
    name: 'dsh-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          // Conditional spread: under exactOptionalPropertyTypes the plain
          // `jsx: X | undefined` is not assignable to the optional property.
          ...(file.endsWith('x') ? { jsx: ts.JsxEmit.ReactJSX } : {}),
          sourceMap: true,
        },
      })
      return {
        code: result.outputText
          .replace(
            /^(\s*)(__esDecorate\()/gmu,
            '$1/* v8 ignore next -- compiler-synthetic decorator accessors have no source behavior */ $2',
          )
          .replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

// tsconfig.test-paths.json extends tsconfig.base.json with the source-plane
// mappings the test suites need: our own workspace packages resolve to their
// src (so the suites exercise the source plane), while platform packages
// resolve normally through node_modules. paths must win over package exports
// for the workspace packages so a stale built lib/ never loads a second
// module-singleton copy.
const pathsPlugin = (): ReturnType<typeof tsconfigPaths> =>
  tsconfigPaths({ projects: ['./tsconfig.test-paths.json'] })

export default defineConfig({
  plugins: [standardDecoratorPlugin(), pathsPlugin()],
  test: {
    include: ['packages/*/*/tests/**/*.spec.ts', 'packages/*/*/tests/**/*.spec.tsx'],
    exclude: ['node_modules/**'],
    server: {
      deps: {
        // The suites execute some platform packages' published lib (their
        // node halves import .module.css, which Node ESM cannot load). Inline
        // the @deepseek-ai packages so Vite's pipeline (css + decorators)
        // processes them instead of Node's loader.
        inline: [/@deepseek-ai\//],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['packages/*/*/src/**'],
      // packages/typert/protocol is the typert generator's build-only
      // registration shell (Task 1 deviation): its src/ is a vendored snapshot
      // that follows the platform checkout, never loaded by tests, so it can
      // never be executed and would hold the per-file 100% gate red forever.
      exclude: ['packages/typert/protocol/**'],
      // Tiered coverage (2026-09-07 拍板, 批 A1; the consolidated plan that
      // ruled it now lives only in git history). The policy — which files land
      // in which tier, and why — lives in THIS object, the numeric source of
      // truth AGENTS.md 修改与验证 defers to. One trap that must stay
      // beside it, because it silently defeats the object below: vitest builds
      // one threshold set per glob key and checks every matching file against
      // EVERY set (AND semantics, no cross-set skip — verified in vitest 4.1.8
      // resolveThresholds/checkThresholds), so a `**` catch-all would re-apply
      // 100% branches to every client .tsx and kill the display tier. The two
      // keys below are a complementary partition; keep them that way.
      thresholds: {
        perFile: true,
        'packages/client/**/*.tsx': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 80,
        },
        '**/*.ts': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100,
        },
      },
    },
  },
})
