# Running plugin-owned CI from an app repo

The CI lane runners (`scripts/ci/*.mjs`, `scripts/ci/*.sh`,
`scripts/ci/lib/*`) and the shared hook libraries (`scripts/hooks/lib/*`)
live in **this plugin**, not in app repos. GitHub Actions jobs in an app
repo check the marketplace out next to the app tree and point every
script invocation at it through `ST_PLUGIN_ROOT`.

## Consumer snippet

Add these two steps to every job that runs a plugin script — directly
after the job's own `actions/checkout`, before any step that runs
`node`, `pnpm`, or a pass-cache action:

```yaml
      - name: Checkout sea-trials plugin
        uses: actions/checkout@v4
        with:
          repository: hughesyadaddy/sea-trials-cursor-marketplace
          ref: ${{ vars.ST_PLUGIN_REF || 'main' }}
          path: .st-plugin
      - name: Setup sea-trials plugin
        uses: ./.st-plugin/plugins/sea-trials/ci/setup
```

Any current major of `actions/checkout` works; use whatever the app repo
already pins. The marketplace is public, so the default `GITHUB_TOKEN`
(including the read-only one on fork and Dependabot PRs) is enough.

Then call scripts by absolute path:

```yaml
      - run: node "$ST_PLUGIN_ROOT/scripts/ci/run-lane.mjs" --lane static
      - run: bash "$ST_PLUGIN_ROOT/scripts/ci/run-dart-analyze-extras-local.sh"
```

The absolute path keeps working under `working-directory:` (for example
`working-directory: flutter`). Scripts resolve the **app** repo root from
`ST_REPO_ROOT` or `git rev-parse --show-toplevel` of the current
directory, never from their own location, so nothing else changes.

## What the setup action exports

| Name | Where | Value |
| --- | --- | --- |
| `ST_PLUGIN_ROOT` | `$GITHUB_ENV` + output `plugin-root` | Absolute path of `plugins/sea-trials` inside the checkout |
| `ST_PLUGIN_SHA` | `$GITHUB_ENV` + output `plugin-sha` | `git rev-parse HEAD` of the marketplace checkout |

The action installs nothing (no Node, no pnpm) and has no inputs. It
fails if `scripts/st-run.mjs` is missing from the resolved root or if
`.st-plugin` is not its own git checkout — the latter would otherwise
make `git rev-parse` answer for the app repo and key caches on the wrong
SHA.

## Pinning: the `ST_PLUGIN_REF` repository variable

`ref:` reads the repository variable `ST_PLUGIN_REF` and falls back to
`main`. Set it to a tag or commit SHA to pin the app repo to a known
plugin revision, and bump it deliberately:

```bash
gh variable set ST_PLUGIN_REF --body v1.4.0 -R <owner>/<app-repo>
```

Leaving it at `main` means every plugin commit changes `ST_PLUGIN_SHA`,
which invalidates every cache key that includes it (below).

## Cache keys

Lanes whose skip logic or runner is plugin code used to hash the
scripts they ran (`hashFiles('scripts/ci/**')`, or
`scripts/hooks/lib/*.mjs` listed as pass-cache `paths:`). Those files no
longer exist in the app tree, so include the plugin revision instead:

```yaml
      key: my-lane-${{ runner.os }}-${{ env.ST_PLUGIN_SHA }}-${{ hashFiles('scripts/ci/pr-lane-registry.mjs') }}
```

Keep hashing the app-owned inputs (the lane registry, config-parity
tests, the app's own sources) exactly as before; only the plugin-owned
part is replaced by `${{ env.ST_PLUGIN_SHA }}`. The setup action must
run **before** the cache step or `env.ST_PLUGIN_SHA` is empty and the key
silently collapses across plugin versions.

## Keep `.st-plugin/` out of the app tree

- Add `.st-plugin/` to the app repo's `.gitignore`. Git-based tooling
  (`git ls-files`, `git diff`, `rg`) then ignores it automatically.
- Tools that walk the filesystem directly (`find`, cspell globs,
  hand-rolled `fs.readdir` scanners, "no README in feature folders"
  guards, secret scanners) need an explicit `.st-plugin` exclude — the
  plugin ships dozens of Markdown files and its own `.github/`.
- Never list `.st-plugin/**` in a workflow `paths:` filter or pass-cache
  `paths:`; it is not tracked, so the glob can never match.

## Local parity

Locally the same scripts come from the installed Cursor/Claude plugin:
`.husky/st-plugin-run.sh` resolves it (see the plugin root resolution
order in the plugin README) and exports `ST_PLUGIN_ROOT`. To run against
a development checkout instead:

```bash
export ST_PLUGIN_ROOT=/path/to/sea-trials-cursor-marketplace/plugins/sea-trials
pnpm pr-local-ci -- --pr <n>
```

The app repo's config-parity tests (`scripts/ci/*.test.mjs`) import
plugin modules through `scripts/ci/st-plugin.mjs` and require
`ST_PLUGIN_ROOT` to be set; in CI the setup action provides it.
