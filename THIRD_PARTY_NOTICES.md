# Third-party notices

This repository is MIT-licensed (see [LICENSE](LICENSE)). It also contains
generated contracts, artwork, and a vendored build shell derived from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), which is
distributed under the MIT License:

- `packages/typert/protocol/**` — the vendored Typert protocol build shell that
  follows the same platform line. It is `private` and is never published.
- `packages/client/chrome/src/ui/icon-artwork.ts` — product icon artwork copied
  verbatim from the platform's `@deepseek-ai/dsh-client-ui-primitives` package,
  so the application chrome draws the same glyphs as DeepSeek Harness.

The platform source is not modified on disk by this project except for the
normalization performed when the Typert shell is refreshed
(`node scripts/platform-line.mjs --set`, which drops the Cordis `Context`
augmentation). All other files are this project's own work.
