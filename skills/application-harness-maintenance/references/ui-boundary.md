# Client UI boundary

## Current local controls

`packages/client/chrome/src/ui/` owns the application-facing controls:

- `Button`, `Switch`, `Tooltip`, `Modal`, `Menu` / `MenuItemButton`, `FenceCodeBlock`;
- a small SVG icon set;
- `snapshot-store.ts` for UI view state/preferences.

`packages/client/applications` and the app views consume these through `@matrix1001/dsh-application-harness-client-chrome`. No production client file value-imports a `@deepseek-ai/dsh-client-*` package.

## Styling

- Use `--dsw-alias-*` theme tokens and the application scale in `tokens.module.css`; no literal colors or fixed font sizes in page chrome.
- `--dsw-alias-label-secondary` is the accessible metadata fallback. Do not use `label-tertiary` for body copy: it is below the app's AA floor.
- A token that no longer exists silently falls back to inherited color. Compare used tokens with the installed theme, not just CSS variable names.
- Keep the app page's own layout/scroll behavior; do not import platform chat typography or chat markdown.

## Menu

The local menu supports:
- `items` data or `MenuItemButton` children;
- `anchor`, `open`, `onSelect`, `onClose`, `align`, `autoFocus`, optional `portal`;
- menu/menuitem roles, Arrow/Home/End, Escape, outside pointerdown, danger/disabled rows.

When changing it, test anchor positioning, outside click, keyboard wrap, row activation, and the app's own `data-*` anchors. Do not silently switch a consumer's portal behavior.

## Modal

The local modal uses `useModalFocus`, a presentation wrapper, an aria-hidden mask, and a role=dialog panel. It supports headless content, description, footer and close label. Preserve:

- focus enters the panel or `[data-modal-autofocus]`;
- Tab wrap and Escape;
- mask click;
- focus restoration;
- `data-modal-backdrop`/role presentation expectations used by dialogs.

## Settings

The network proxy page consumes only the structural `ConfigForm` face (`getSnapshot`/`subscribe`/`mutate`). Keep dirty/invalid/reset/read-only/error behavior; a successful save must not claim success when the Host refused or the transport rejected.

## Verification

- `pnpm exec vitest run packages/client/chrome/tests packages/client/applications/tests apps/*/view/tests`
- `pnpm run test:browser`
- manual 2× and dark-theme check before release
- `node scripts/check-client-ui-imports.mjs`
- update `scripts/api-snapshot.json` when the chrome public surface changes

## Migrating another platform component

1. Identify all consumers and props/data attributes.
2. Write a local control with the same public contract and a stable test anchor.
3. Move imports in small files; keep behavior tests green.
4. Remove the package devDependency only after no value import remains.
5. Run the import gate and release checks.
