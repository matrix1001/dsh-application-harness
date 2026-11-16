# Third-party notices

This repository is MIT-licensed (see [LICENSE](LICENSE)). It also contains
source snapshots and generated contracts derived from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), which is
distributed under the MIT License:

- `.platform-src/**` — source snapshots of DeepSeek Harness packages used only
  by this repository's tests and contract checks. The upstream MIT text is kept
  at [.platform-src/LICENSE](.platform-src/LICENSE). The source line and commit
  are recorded in [scripts/platform-src-lock.json](scripts/platform-src-lock.json);
  the snapshot is maintained by `scripts/vendor-platform-src.mjs` and is not the
  platform's current checkout.
- `packages/typert/protocol/**` — the vendored Typert protocol build shell that
  follows the same platform line. It is `private` and is never published.

The platform source is not modified on disk by this project except for the
documented normalization performed by the vendor script. All other files are
this project's own work.
