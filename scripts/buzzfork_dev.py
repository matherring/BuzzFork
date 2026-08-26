#!/usr/bin/env python3
"""Disk-safe local build and worktree lifecycle commands for BuzzFork."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import os
from pathlib import Path
import platform
import subprocess
import sys
from typing import Sequence

from buzzfork_build_guard import MIN_FREE_BYTES, format_gib, free_bytes, run_guarded


MAX_AUXILIARY_WORKTREES = 2
EXIT_REFUSED = 75


@dataclass(frozen=True)
class Worktree:
    path: Path
    head: str
    branch: str | None
    primary: bool
    clean: bool
    upstream: str | None
    ahead: int | None
    behind: int | None


def git(
    repo: Path,
    args: Sequence[str],
    *,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=check,
        text=True,
        capture_output=True,
    )


def repo_root(path: Path) -> Path:
    result = git(path, ["rev-parse", "--show-toplevel"])
    return Path(result.stdout.strip()).resolve()


def parse_worktree_porcelain(raw: str) -> list[dict[str, str | bool]]:
    records: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] = {}
    for line in [*raw.splitlines(), ""]:
        if not line:
            if current:
                records.append(current)
                current = {}
            continue
        key, separator, value = line.partition(" ")
        current[key] = value if separator else True
    return records


def inspect_worktrees(repo: Path) -> list[Worktree]:
    root = repo_root(repo)
    listing = git(root, ["worktree", "list", "--porcelain"]).stdout
    records = parse_worktree_porcelain(listing)
    worktrees: list[Worktree] = []

    for index, record in enumerate(records):
        path = Path(str(record["worktree"])).resolve()
        branch_ref = record.get("branch")
        branch = (
            str(branch_ref).removeprefix("refs/heads/")
            if isinstance(branch_ref, str)
            else None
        )
        status = git(
            path,
            ["status", "--porcelain=v1", "--untracked-files=all"],
        ).stdout
        upstream_result = git(
            path,
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            check=False,
        )
        upstream = (
            upstream_result.stdout.strip()
            if branch and upstream_result.returncode == 0
            else None
        )
        ahead: int | None = None
        behind: int | None = None
        if upstream:
            counts = git(
                path,
                ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            ).stdout.split()
            ahead, behind = (int(value) for value in counts)

        worktrees.append(
            Worktree(
                path=path,
                head=str(record["HEAD"]),
                branch=branch,
                primary=index == 0,
                clean=not status.strip(),
                upstream=upstream,
                ahead=ahead,
                behind=behind,
            )
        )
    return worktrees


def default_cargo_target() -> Path:
    override = os.environ.get("BUZZFORK_CARGO_TARGET_DIR")
    if override:
        return Path(override).expanduser().resolve()
    xdg_cache = os.environ.get("XDG_CACHE_HOME")
    if xdg_cache:
        cache_root = Path(xdg_cache).expanduser()
    elif platform.system() == "Darwin":
        cache_root = Path.home() / "Library" / "Caches"
    else:
        cache_root = Path.home() / ".cache"
    return (cache_root / "buzzfork" / "cargo-target").resolve()


def print_status(worktrees: Sequence[Worktree], disk_path: Path) -> None:
    print("Registered BuzzFork worktrees:")
    for worktree in worktrees:
        role = "primary" if worktree.primary else "auxiliary"
        branch = worktree.branch or "(detached)"
        if worktree.upstream:
            upstream = (
                f"{worktree.upstream} "
                f"(ahead {worktree.ahead}, behind {worktree.behind})"
            )
        else:
            upstream = "(no upstream)"
        state = "clean" if worktree.clean else "dirty"
        print(
            f"- {role}: {worktree.path}\n"
            f"  branch: {branch}\n"
            f"  upstream: {upstream}\n"
            f"  status: {state}"
        )
    available = free_bytes(disk_path)
    print(
        f"Free disk: {format_gib(available)} "
        f"(required floor {format_gib(MIN_FREE_BYTES)})"
    )
    print(f"Shared Cargo target: {default_cargo_target()}")


def quote_command(parts: Sequence[str | Path]) -> str:
    import shlex

    return shlex.join(str(part) for part in parts)


def ensure_disk_floor(path: Path) -> list[str]:
    available = free_bytes(path)
    if available >= MIN_FREE_BYTES:
        return []
    return [
        f"only {format_gib(available)} is free; "
        f"the required floor is {format_gib(MIN_FREE_BYTES)}"
    ]


def create_errors(
    worktrees: Sequence[Worktree],
    *,
    disk_path: Path,
    destination: Path,
    branch_valid: bool = True,
    branch_exists: bool = False,
    base_exists: bool = True,
) -> list[str]:
    errors = ensure_disk_floor(disk_path)
    auxiliary_count = sum(not worktree.primary for worktree in worktrees)
    if auxiliary_count >= MAX_AUXILIARY_WORKTREES:
        errors.append(
            f"{auxiliary_count} auxiliary worktrees are already registered; "
            f"the budget is {MAX_AUXILIARY_WORKTREES}"
        )
    if destination.exists() or destination.is_symlink():
        errors.append(f"destination already exists: {destination}")
    if not branch_valid:
        errors.append("the requested branch name is not valid")
    elif branch_exists:
        errors.append("the requested branch already exists")
    if not base_exists:
        errors.append("the requested base does not resolve to a commit")
    return errors


def finish_errors(worktree: Worktree | None) -> list[str]:
    if worktree is None:
        return ["the requested path is not a registered worktree"]
    errors: list[str] = []
    if worktree.primary:
        errors.append("the primary checkout cannot be removed")
    if not worktree.clean:
        errors.append("tracked or untracked changes remain")
    if not worktree.branch:
        errors.append("the worktree is detached; preserve its commit on a branch")
    elif not worktree.upstream:
        errors.append("the branch has no upstream; push it before removal")
    elif worktree.ahead:
        errors.append(
            f"the branch is {worktree.ahead} commit(s) ahead of "
            f"{worktree.upstream}; push it before removal"
        )
    return errors


def report_refusal(errors: Sequence[str]) -> int:
    print("buzzfork-dev: refused", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    return EXIT_REFUSED


def command_status(args: argparse.Namespace) -> int:
    root = repo_root(args.repo)
    print_status(inspect_worktrees(root), root)
    return 0


def command_cargo_target(_args: argparse.Namespace) -> int:
    print(default_cargo_target())
    return 0


def command_build(args: argparse.Namespace) -> int:
    root = repo_root(args.repo)
    environment = os.environ.copy()
    environment["CARGO_TARGET_DIR"] = str(default_cargo_target())
    os.environ["CARGO_TARGET_DIR"] = environment["CARGO_TARGET_DIR"]
    print(f"buzzfork-dev: shared Cargo target {environment['CARGO_TARGET_DIR']}")
    return run_guarded(args.command, root)


def command_create(args: argparse.Namespace) -> int:
    root = repo_root(args.repo)
    worktrees = inspect_worktrees(root)
    destination = args.path.expanduser().resolve()
    print_status(worktrees, root)
    errors = create_errors(
        worktrees,
        disk_path=root,
        destination=destination,
        branch_valid=(
            git(root, ["check-ref-format", "--branch", args.branch], check=False).returncode
            == 0
        ),
        branch_exists=(
            git(
                root,
                ["show-ref", "--verify", f"refs/heads/{args.branch}"],
                check=False,
            ).returncode
            == 0
            or git(
                root,
                ["show-ref", "--verify", f"refs/remotes/origin/{args.branch}"],
                check=False,
            ).returncode
            == 0
        ),
        base_exists=(
            git(root, ["rev-parse", "--verify", f"{args.base}^{{commit}}"], check=False).returncode
            == 0
        ),
    )
    if errors:
        return report_refusal(errors)

    command = [
        "git",
        "-C",
        root,
        "worktree",
        "add",
        "-b",
        args.branch,
        "--",
        destination,
        args.base,
    ]
    mode = "execute" if args.execute else "dry-run"
    print(f"buzzfork-dev: {mode}: {quote_command(command)}")
    if not args.execute:
        return 0
    subprocess.run([str(part) for part in command], check=True)
    print_status(inspect_worktrees(root), root)
    return 0


def command_finish(args: argparse.Namespace) -> int:
    root = repo_root(args.repo)
    worktrees = inspect_worktrees(root)
    requested = args.worktree.expanduser().resolve()
    worktree = next((item for item in worktrees if item.path == requested), None)
    print_status(worktrees, root)
    errors = finish_errors(worktree)
    if errors:
        return report_refusal(errors)

    assert worktree is not None
    primary = next(item for item in worktrees if item.primary)
    remove = ["git", "-C", primary.path, "worktree", "remove", worktree.path]
    prune = ["git", "-C", primary.path, "worktree", "prune"]
    mode = "execute" if args.execute else "dry-run"
    print(f"buzzfork-dev: {mode}: {quote_command(remove)}")
    print(f"buzzfork-dev: {mode}: {quote_command(prune)}")
    print(
        "buzzfork-dev: removing the worktree also removes its generated build "
        "output; the preserved branch is not deleted"
    )
    if not args.execute:
        return 0
    subprocess.run([str(part) for part in remove], check=True)
    subprocess.run([str(part) for part in prune], check=True)
    print_status(inspect_worktrees(primary.path), primary.path)
    return 0


def destructive_mode(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action="store_true",
        help="preview without changing worktrees (the default)",
    )
    mode.add_argument(
        "--execute",
        action="store_true",
        help="perform the displayed git worktree operation",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path.cwd(),
        help="any checkout or worktree for the repository (default: cwd)",
    )
    commands = parser.add_subparsers(dest="subcommand", required=True)

    status = commands.add_parser("status", help="report worktrees and free disk")
    status.set_defaults(handler=command_status)

    cargo_target = commands.add_parser(
        "cargo-target",
        help="print the shared local Cargo target path",
    )
    cargo_target.set_defaults(handler=command_cargo_target)

    build = commands.add_parser(
        "build",
        help="run a local command with the disk guard and shared Cargo target",
    )
    build.add_argument("command", nargs=argparse.REMAINDER)
    build.set_defaults(handler=command_build)

    create = commands.add_parser(
        "create",
        help="preflight and optionally create an auxiliary worktree",
    )
    create.add_argument("path", type=Path)
    create.add_argument("branch")
    create.add_argument("--base", default="origin/main")
    destructive_mode(create)
    create.set_defaults(handler=command_create)

    finish = commands.add_parser(
        "finish",
        help="verify and optionally remove a completed worktree",
    )
    finish.add_argument("worktree", type=Path)
    destructive_mode(finish)
    finish.set_defaults(handler=command_finish)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.subcommand == "build":
        if args.command[:1] == ["--"]:
            args.command = args.command[1:]
        if not args.command:
            parser.error("build requires a command after --")
    try:
        return int(args.handler(args))
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"buzzfork-dev: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
