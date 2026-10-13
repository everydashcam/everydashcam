---
paths:
  - "src/portable/**/*"
  - "src/types/portable.d.ts"
  - "vite.portable.config.ts"
  - "vite-plugins/portable*.ts"
  - "vite-plugins/edition-markup.ts"
  - "scripts/*portable*.mjs"
  - "scripts/*portable*.mts"
  - "tests/portable/**/*"
  - "tests/playwright.portable.config.ts"
---

# Portable HTML

Apply these rules to portable artifacts and shared viewer/map/export changes that
affect the file-origin edition, even when the edited path is outside this scope.

## Runtime and build boundaries

- Keep portable on shared application code. Use the existing `__PORTABLE__`
  boundary and aliases in `vite.portable.config.ts` to exclude hosted features;
  hiding controls alone is insufficient.
- The artifact must open directly from `file://` without a server or companion
  files. API availability alone does not prove an API works on a file origin.
- Keep builds independent of hosted configuration and checkout `.env` files.
  Accept only explicit portable inputs. The optional Yandex browser key is an
  intentional embedded input; unrelated hosted keys, telemetry configuration,
  and private delivery settings must not enter public artifacts.
- Route-only is the last automatic map fallback; preserve an explicit local-only
  choice. Failed recovery probes must not rebuild a working local map or overwrite
  preferences. Export map sessions remain independent.

## Validation and publication

- Rebuild affected artifacts and test actual file URLs with `tests/portable/`.
  Shared viewer changes also need hosted regression coverage. Keep external
  requests intercepted, use synthetic provider keys and public recording fixtures.
- Validate local development artifacts with
  `PORTABLE_ALLOW_DEV=1 node scripts/validate-portable-artifacts.mjs` after the
  build. Use release validation without that escape hatch for publication; see
  [the deployment runbook](../../docs/deploy.md).
- Inspect compressed content through `scripts/_portable-content.mjs`. Compute
  published sizes and hashes from actual downloaded bytes, not decoded content.
- Publish only validated manifest entries. Artifacts must be available before
  links or latest-version metadata point to them.

Build/publication entry points: `scripts/build-portable.mjs`,
`vite-plugins/portable.ts`, and `vite-plugins/portable-downloads.ts`.
Runtime entry point: `src/portable/bootstrap.ts`; browser setup:
`tests/portable/_fixtures.ts` and `tests/playwright.portable.config.ts`.
