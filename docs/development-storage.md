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

## Canonical desktop promotion and rollback

The family-office fork has exactly one live desktop path:
`/Applications/Buzz.app`. Managed agents must run only the sidecars bundled
next to that installed app; never point an agent at a checkout, worktree,
Cargo target, or a versioned application archive. The one retained rollback is
`/Applications/Buzz.previous.app`. A single candidate lives outside worktrees
under Buzz application support (the paths are configurable only for tests).

Upstream updates are first integrated into BuzzFork, pushed, and validated on
the fork. Do not launch a vanilla upstream build. This private workflow does
not use Tauri updater infrastructure; updater endpoints remain empty and no
updater credentials belong in this repository.

Every mutation previews by default. Use this single source-to-installed flow
for every upstream desktop upgrade. `upgrade` uses read-only remote discovery
in dry-run mode, selects the highest stable official `desktop-vX.Y.Z` tag (or
the exact `--tag`), and refuses a non-official remote, a dirty or unpushed
auxiliary worktree, a lifecycle lock, less than 50 GiB free, a pending
candidate, or a merge conflict. With `--execute` it fetches that exact tag,
merges it with a signed-off merge commit, and pushes the current fork branch.
It never compiles, packages, changes an installed app, or opens a release.

```bash
# Run from a clean auxiliary BuzzFork worktree, never the dirty primary checkout.
python3 scripts/buzzfork_dev.py upgrade --dry-run
python3 scripts/buzzfork_dev.py upgrade --tag desktop-v0.5.20 --dry-run
python3 scripts/buzzfork_dev.py upgrade --execute
```

After GitHub Actions reports successful CI for the exact pushed merge head,
copy that full SHA from the command output into the existing staged-build flow:

```bash
python3 scripts/buzzfork_dev.py status
python3 scripts/buzzfork_dev.py stage <exact-40-character-pushed-SHA> --dry-run
python3 scripts/buzzfork_dev.py stage <exact-40-character-pushed-SHA> --execute

# Mat-approved maintenance window: quit Buzz and all bundled harnesses yourself.
python3 scripts/buzzfork_dev.py promote --dry-run
python3 scripts/buzzfork_dev.py promote --execute

# Relaunch /Applications/Buzz.app manually, then prove its process and hashes.
python3 scripts/buzzfork_dev.py verify
python3 scripts/buzzfork_dev.py accept --dry-run
python3 scripts/buzzfork_dev.py accept --execute
```

`stage` refuses moving refs, dirty or unpushed source, a second candidate, a
worktree-budget breach, a held lifecycle lock, less than 50 GiB free, or a
non-green hosted CI run for the exact SHA. It validates the signed Apple
Silicon bundle, bundle id, required non-empty sidecars, and all recorded
SHA-256 hashes before copying it to the candidate slot.

This is also the deterministic recompilation command: it runs the focused
desktop format check and one guarded release package build using the shared
Cargo target, then validates and copies exactly one candidate. Do not invoke
an ad-hoc Tauri build for a fleet upgrade.

Promotion and rollback never quit or kill Buzz. They refuse when process-path
inspection finds a process using an install slot, or cannot reliably inspect
it. A journal makes interrupted moves recoverable on the next lifecycle
invocation. At any live gate, with Buzz stopped, the rollback path is:

```bash
python3 scripts/buzzfork_dev.py rollback --dry-run
python3 scripts/buzzfork_dev.py rollback --execute
# Relaunch /Applications/Buzz.app manually, then run verify.
```

`accept` removes the consumed candidate and exact temporary package output,
but retains exactly one rollback. It does not use Finder, forced worktree
removal, broad deletion, or Docker cleanup.
