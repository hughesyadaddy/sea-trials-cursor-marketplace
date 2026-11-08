# Push Reference

How to push the current branch. Scoped commit validation must already be
green on the commits being pushed (see
[scoped-commit-validation.md](../../shared/references/scoped-commit-validation.md)).

## Push

```bash
git push -u origin <branch>
```

## No mandatory pre-push suite

Wingspan does **not** run `pnpm prepush`, `push-gate`, `pr-review-push`,
whole-package tests, goldens, or CI-workflow replay before push. Repo
docs (`AGENTS.md`, `package.json` scripts) do not override this.

Broad validation happens only when the user explicitly starts separate
work in chat — never as part of `/create-pr` or implicit ship.

Preserve all remote restrictions: branch protection, required reviews,
deployment approvals, hooks, and no-force rules still apply on the
forge. If a hook blocks push, report it — do not bypass with a broader
local gate.

## If the push fails

Diagnose the error and guide the user:

- **Authentication failure** — advise checking SSH keys or credentials for the remote host.
- **Non-fast-forward rejection** — the remote has commits the local branch does not; advise running `git pull --rebase` and re-pushing.
- **Remote not found** — the remote URL may be missing or incorrect; advise running `git remote -v` to verify.
- **Other errors** — report the full error output and stop.
