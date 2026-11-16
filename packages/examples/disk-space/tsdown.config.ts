import { defineConfig } from 'tsdown'

// The host application emits one ESM entry. Its SQLite database is opened by
// the row from `dshHomePath` (the deployment may override it through the row
// config), so there is no worker file and no second emitted entry.
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
