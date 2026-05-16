# Publishing the composite action

This repo ships one consumable surface: the **`claude-managed-agents-pipeline`
composite action**, published to the GitHub Marketplace. The action handles
secret-provider wiring (AWS / Vault / Azure / 1Password / LastPass / GitHub
Secrets) and runs the pipeline's `pnpm install` against the action's checkout —
it relies on Node + corepack already being present on the runner
(`ubuntu-latest` has both preinstalled). Everything else — the workflows that
lint, review, evaluate, red-team, and deploy agents — lives in this repo as
the reference implementation that consumers fork or copy.

## Cutting a release

[`.github/workflows/release.yaml`](../.github/workflows/release.yaml) handles
the mechanics. To cut version `v1.2.3`:

```bash
# from main, after the relevant PRs have merged
git tag v1.2.3
git push origin v1.2.3
```

Pushing the tag triggers the release workflow:

1. Validates the tag is semver-shaped and `action.yaml` is well-formed.
2. Force-moves the floating major-version tag (`v1` for any `v1.x.y`).
3. Creates a GitHub Release with auto-generated notes.

Pre-releases (e.g. `v1.0.0-rc.1`) are published but do **not** move the floating
major tag.

## Marketplace listing — first-time setup

The action is Marketplace-eligible because:

- `action.yaml` lives at `.github/actions/claude-managed-agents-pipeline/action.yaml`.
- It has a `name`, `description`, `author`, and a `branding` block
  (`icon: shield`, `color: orange`) — the bare-minimum Marketplace
  requirements.

To publish to the Marketplace the first time:

1. Go to **Releases** in this repo.
2. Open the auto-created release for the first stable tag (e.g. `v1.0.0`).
3. Tick **"Publish this Action to the GitHub Marketplace."**
4. Pick a category — recommended **Security**.
5. Save.

Subsequent releases (`v1.0.1`, `v1.1.0`, …) auto-update the listing as long as
the floating `v1` tag is moved by `release.yaml`.

## SemVer policy

- **Major** — breaking change to action inputs or the `agent.yaml` schema.
- **Minor** — new inputs (defaulted), new providers, additive schema changes.
- **Patch** — bug fixes, doc updates, dependency bumps that don't affect the
  public surface.

Keep the floating `v1` tag pointing at the latest 1.x. Callers using `@v1` get
fixes automatically.

## Removing or renaming a public input

Don't. Add the new input, deprecate the old one in the action description, and
bump major in the next release. This is a public surface.
