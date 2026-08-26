# Disk-safe BuzzFork development

BuzzFork keeps one primary checkout and at most two auxiliary worktrees: one
active implementation tree and one temporary canary/packaging tree. Cleanup is
part of finishing the task that created a worktree.

## Inspect and create

Refresh the remote refs, inspect the registered worktrees, and preview creation
before executing it:

```bash
git fetch --prune origin
python3 scripts/buzzfork_dev.py status
python3 scripts/buzzfork_dev.py create ../BuzzFork-my-change feature/my-change --base origin/main --dry-run
python3 scripts/buzzfork_dev.py create ../BuzzFork-my-change feature/my-change --base origin/main --execute
```

The script prints each worktree's branch, clean/dirty status, upstream, and
ahead/behind counts. It refuses creation when two auxiliaries are already
registered, the destination exists, the branch/base is invalid, or less than
50 GiB is free. It never retires another worktree to make room.

Do not delete worktrees in Finder or with `rm`. An existing tree must pass the
finish gate below before it can be retired.

## Build and validate

Local builds and test suites use the monitored 50 GiB disk guard and one shared
Cargo target across all BuzzFork worktrees:

```bash
python3 scripts/buzzfork_dev.py cargo-target
python3 scripts/buzzfork_dev.py build -- cargo test -p buzz-cli
just local-cargo test -p buzz-cli
```

The portable default is the platform user-cache directory under
`buzzfork/cargo-target`. Override it without changing repository files:

```bash
export BUZZFORK_CARGO_TARGET_DIR=/path/on/a/local/volume/buzzfork-cargo-target
```

Run only formatting, linting, type checking, and focused tests for the changed
surface. Do not run full `just ci`, full-workspace compilation, or local
packaging unless GitHub Actions is unavailable or an interactive canary truly
requires it. Only one local canary may exist at a time; remove its intermediate
output immediately after the accept/reject verdict.

Push early and open a draft PR. The `CI` workflow runs on every feature-branch
push, which exercises all broad jobs, and on pull requests with the existing
path filters. The development-policy paths are included in the Rust filter so
the preflight tests and relevant compiled lanes run on the PR event too.

```bash
branch="$(git branch --show-current)"
git push -u origin "$branch"
gh pr create --repo matherring/BuzzFork --draft --base main --head "$branch" --fill
gh run list --repo matherring/BuzzFork --workflow ci.yml --branch "$branch"
run_id="$(gh run list --repo matherring/BuzzFork --workflow ci.yml --branch "$branch" --event push --limit 1 --json databaseId --jq '.[0].databaseId')"
gh run watch --repo matherring/BuzzFork "$run_id" --exit-status
```

GitHub-hosted targets and caches stay on the runner. Download only a final,
short-lived artifact needed for an explicit canary; never download Cargo
`target` trees or Actions caches.

## Finish and retire

Commit required work, push the branch, then preview retirement. The gate
refuses a dirty or detached tree, a branch without an upstream, or a branch
with unpushed commits:

```bash
worktree_path="$(git rev-parse --show-toplevel)"
git status --short --branch
git push
python3 scripts/buzzfork_dev.py finish "$worktree_path" --dry-run
python3 scripts/buzzfork_dev.py finish "$worktree_path" --execute
```

Execution uses `git worktree remove` without force, then `git worktree prune`.
Removing the completed worktree removes its generated dependencies, targets,
and app bundles while leaving the pushed branch intact. The final output lists
all remaining worktrees and current free disk space.

Development cleanup must never stop, prune, or modify the production Buzz
Docker containers or volumes.
