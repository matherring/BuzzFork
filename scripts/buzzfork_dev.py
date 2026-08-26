#!/usr/bin/env python3
"""Disk-safe BuzzFork worktree and canonical-desktop lifecycle commands.

All desktop mutations are previews until ``--execute`` is supplied.  The
installer owns exactly three durable slots: ``/Applications/Buzz.app`` (live),
``/Applications/Buzz.previous.app`` (rollback), and one external candidate.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterator, Sequence

from buzzfork_build_guard import MIN_FREE_BYTES, format_gib, free_bytes, run_guarded


MAX_AUXILIARY_WORKTREES = 2
EXIT_REFUSED = 75
EXPECTED_BUNDLE_ID = "xyz.block.buzz.app"
DESKTOP_EXECUTABLE = "buzz-desktop"
REQUIRED_SIDECARS = ("buzz-acp", "buzz-agent", "buzz-backend-kubernetes", "buzz-dev-mcp", "git-credential-nostr", "buzz")
BUNDLED_EXECUTABLES = (DESKTOP_EXECUTABLE, *REQUIRED_SIDECARS)
SHA = re.compile(r"^[0-9a-f]{40}$")


@dataclass(frozen=True)
class Worktree:
    path: Path; head: str; branch: str | None; primary: bool; clean: bool; upstream: str | None; ahead: int | None; behind: int | None


@dataclass(frozen=True)
class InstallPaths:
    stable: Path; previous: Path; candidate: Path; state_dir: Path
    @property
    def manifest(self) -> Path: return self.state_dir / "install-state.json"
    @property
    def journal(self) -> Path: return self.state_dir / "desktop-transaction.json"
    @property
    def lock(self) -> Path: return self.state_dir / "desktop-build.lock"
    @property
    def prestage(self) -> Path: return self.stable.parent / ".Buzz.promoting.app"
    @property
    def retired(self) -> Path: return self.stable.parent / ".Buzz.previous.retired.app"
    @property
    def displaced(self) -> Path: return self.stable.parent / ".Buzz.rollback-displaced.app"


@dataclass(frozen=True)
class BundleIdentity:
    bundle: str; version: str; executable_hash: str; sidecar_hashes: dict[str, str]; bundle_id: str


@dataclass(frozen=True)
class ProcessInspection:
    available: bool; paths: tuple[Path, ...] = (); detail: str = ""


def git(repo: Path, args: Sequence[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", "-C", str(repo), *args], check=check, text=True, capture_output=True)


def repo_root(path: Path) -> Path: return Path(git(path, ["rev-parse", "--show-toplevel"]).stdout.strip()).resolve()


def parse_worktree_porcelain(raw: str) -> list[dict[str, str | bool]]:
    records: list[dict[str, str | bool]] = []; current: dict[str, str | bool] = {}
    for line in [*raw.splitlines(), ""]:
        if not line:
            if current: records.append(current); current = {}
            continue
        key, separator, value = line.partition(" "); current[key] = value if separator else True
    return records


def inspect_worktrees(repo: Path) -> list[Worktree]:
    root = repo_root(repo); records = parse_worktree_porcelain(git(root, ["worktree", "list", "--porcelain"]).stdout); worktrees = []
    for index, record in enumerate(records):
        path = Path(str(record["worktree"])).resolve(); branch_ref = record.get("branch")
        branch = str(branch_ref).removeprefix("refs/heads/") if isinstance(branch_ref, str) else None
        clean = not git(path, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.strip()
        upstream_result = git(path, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], check=False)
        upstream = upstream_result.stdout.strip() if branch and upstream_result.returncode == 0 else None; ahead = behind = None
        if upstream: ahead, behind = (int(value) for value in git(path, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).stdout.split())
        worktrees.append(Worktree(path, str(record["HEAD"]), branch, index == 0, clean, upstream, ahead, behind))
    return worktrees


def default_cargo_target() -> Path:
    if override := os.environ.get("BUZZFORK_CARGO_TARGET_DIR"): return Path(override).expanduser().resolve()
    cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ("Library/Caches" if platform.system() == "Darwin" else ".cache")))
    return (cache / "buzzfork" / "cargo-target").resolve()


def install_paths() -> InstallPaths:
    state_dir = Path(os.environ.get("BUZZFORK_INSTALL_STATE_DIR", Path.home() / "Library/Application Support/BuzzFork")).expanduser().resolve()
    stable = Path(os.environ.get("BUZZFORK_STABLE_APP", "/Applications/Buzz.app")).expanduser().resolve()
    previous = Path(os.environ.get("BUZZFORK_PREVIOUS_APP", "/Applications/Buzz.previous.app")).expanduser().resolve()
    candidate = Path(os.environ.get("BUZZFORK_CANDIDATE_APP", state_dir / "Buzz.candidate.app")).expanduser().resolve()
    return InstallPaths(stable, previous, candidate, state_dir)


def quote_command(parts: Sequence[str | Path]) -> str:
    import shlex
    return shlex.join(str(part) for part in parts)


def ensure_disk_floor(path: Path) -> list[str]:
    available = free_bytes(path)
    return [] if available >= MIN_FREE_BYTES else [f"only {format_gib(available)} is free; the required floor is {format_gib(MIN_FREE_BYTES)}"]


def print_status(worktrees: Sequence[Worktree], disk_path: Path, paths: InstallPaths | None = None) -> None:
    print("Registered BuzzFork worktrees:")
    for worktree in worktrees:
        upstream = f"{worktree.upstream} (ahead {worktree.ahead}, behind {worktree.behind})" if worktree.upstream else "(no upstream)"
        print(f"- {'primary' if worktree.primary else 'auxiliary'}: {worktree.path}\n  branch: {worktree.branch or '(detached)'}\n  upstream: {upstream}\n  status: {'clean' if worktree.clean else 'dirty'}")
    print(f"Free disk: {format_gib(free_bytes(disk_path))} (required floor {format_gib(MIN_FREE_BYTES)})\nShared Cargo target: {default_cargo_target()}")
    if paths:
        for label, path in (("Live app", paths.stable), ("Rollback app", paths.previous), ("Candidate app", paths.candidate), ("Install state", paths.manifest)):
            print(f"{label}: {path} ({'present' if path.exists() else 'absent'})")
        if paths.journal.exists(): print(f"Recovery journal pending: {paths.journal}")


def create_errors(worktrees: Sequence[Worktree], *, disk_path: Path, destination: Path, branch_valid: bool = True, branch_exists: bool = False, base_exists: bool = True) -> list[str]:
    errors = ensure_disk_floor(disk_path); count = sum(not item.primary for item in worktrees)
    if count >= MAX_AUXILIARY_WORKTREES: errors.append(f"{count} auxiliary worktrees are already registered; the budget is {MAX_AUXILIARY_WORKTREES}")
    if destination.exists() or destination.is_symlink(): errors.append(f"destination already exists: {destination}")
    if not branch_valid: errors.append("the requested branch name is not valid")
    elif branch_exists: errors.append("the requested branch already exists")
    if not base_exists: errors.append("the requested base does not resolve to a commit")
    return errors


def _lsof_paths(path: Path) -> ProcessInspection:
    """Inspect full real paths, not command names or truncated ps output."""
    if shutil.which("lsof") is None: return ProcessInspection(False, detail="lsof is unavailable")
    try:
        result = subprocess.run(["lsof", "-nP", "-Fpcfn", "+D", str(path)], text=True, capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired) as error: return ProcessInspection(False, detail=f"lsof inspection failed: {error}")
    if result.returncode not in (0, 1): return ProcessInspection(False, detail=f"lsof inspection failed: {result.stderr.strip() or result.returncode}")
    if result.returncode == 1: return ProcessInspection(True)
    seen = []
    for line in result.stdout.splitlines():
        if line.startswith("n") and len(line) > 1:
            value = Path(line[1:].removesuffix(" (deleted)"))
            if value not in seen: seen.append(value)
    return ProcessInspection(True, tuple(seen)) if seen else ProcessInspection(False, detail="lsof returned no parseable full paths")


def processes_using_path(path: Path) -> ProcessInspection: return _lsof_paths(path)


def running_buzz_bundle_processes() -> ProcessInspection:
    """Find Buzz executables by their full open path, including deleted bundles.

    ``lsof +D`` cannot inspect a bundle after its directory has been removed.
    A global, field-formatted lsof listing lets the promotion gate see a deleted
    desktop or bundled harness without trusting the process command name.
    """
    if shutil.which("lsof") is None:
        return ProcessInspection(False, detail="lsof is unavailable")
    try:
        result = subprocess.run(
            ["lsof", "-nP", "-Fpcfn"],
            text=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return ProcessInspection(False, detail=f"global lsof inspection failed: {error}")
    if result.returncode not in (0, 1):
        return ProcessInspection(False, detail=f"global lsof inspection failed: {result.stderr.strip() or result.returncode}")
    if result.returncode == 1:
        return ProcessInspection(True)

    matches: list[Path] = []
    for line in result.stdout.splitlines():
        if not line.startswith("n") or len(line) == 1:
            continue
        raw_path = line[1:]
        clean_path = raw_path.removesuffix(" (deleted)")
        candidate = Path(clean_path)
        if (
            ".app/Contents/MacOS/" in clean_path
            and candidate.name in BUNDLED_EXECUTABLES
        ):
            display = Path(raw_path)
            if display not in matches:
                matches.append(display)
    return ProcessInspection(True, tuple(matches))


def path_process_errors(paths: Sequence[Path], *, inspector=processes_using_path) -> list[str]:
    errors = []
    for path in paths:
        if not path.exists(): continue
        result = inspector(path)
        if not result.available: errors.append(f"cannot safely inspect processes using {path}: {result.detail}")
        elif result.paths: errors.append(f"processes still use {path}: {', '.join(str(item) for item in result.paths)}")
    return errors


def stopped_buzz_errors(paths: Sequence[Path]) -> list[str]:
    """Refuse a slot transaction unless every desktop/harness process is stopped."""
    errors = path_process_errors(paths)
    active_bundles = running_buzz_bundle_processes()
    if not active_bundles.available:
        errors.append(f"cannot safely inspect all running Buzz bundles: {active_bundles.detail}")
    elif active_bundles.paths:
        errors.append("Buzz desktop or a bundled harness is still running: " + ", ".join(str(path) for path in active_bundles.paths))
    return errors


def finish_errors(worktree: Worktree | None, *, inspector=processes_using_path) -> list[str]:
    if worktree is None: return ["the requested path is not a registered worktree"]
    errors = []
    if worktree.primary: errors.append("the primary checkout cannot be removed")
    if not worktree.clean: errors.append("tracked or untracked changes remain")
    if not worktree.branch: errors.append("the worktree is detached; preserve its commit on a branch")
    elif not worktree.upstream: errors.append("the branch has no upstream; push it before removal")
    elif worktree.ahead: errors.append(f"the branch is {worktree.ahead} commit(s) ahead of {worktree.upstream}; push it before removal")
    return errors + path_process_errors([worktree.path], inspector=inspector)


def report_refusal(errors: Sequence[str]) -> int:
    print("buzzfork-dev: refused", file=sys.stderr)
    for error in errors: print(f"- {error}", file=sys.stderr)
    return EXIT_REFUSED


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()


def command_output(command: Sequence[str | Path]) -> str: return subprocess.run([str(item) for item in command], check=True, text=True, capture_output=True).stdout.strip()
def executable(path: Path) -> bool: return path.is_file() and path.stat().st_size > 0 and bool(path.stat().st_mode & stat.S_IXUSR)


def validate_bundle(bundle: Path, *, runner=command_output) -> BundleIdentity:
    info, macos = bundle / "Contents/Info.plist", bundle / "Contents/MacOS"; desktop = macos / DESKTOP_EXECUTABLE; errors = []
    if not info.is_file(): errors.append(f"missing Info.plist: {info}")
    if not executable(desktop): errors.append(f"missing or empty desktop executable: {desktop}")
    for sidecar in REQUIRED_SIDECARS:
        if not executable(macos / sidecar): errors.append(f"missing or empty required sidecar: {macos / sidecar}")
    if errors: raise ValueError("; ".join(errors))
    bundle_id = runner(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleIdentifier", info]); version = runner(["/usr/libexec/PlistBuddy", "-c", "Print :CFBundleShortVersionString", info])
    if bundle_id != EXPECTED_BUNDLE_ID: raise ValueError(f"wrong bundle identifier {bundle_id!r}; expected {EXPECTED_BUNDLE_ID!r}")
    architectures = runner(["lipo", "-archs", desktop]).split()
    if "arm64" not in architectures: raise ValueError(f"desktop executable is not Apple Silicon: {architectures}")
    try: runner(["codesign", "--verify", "--deep", "--strict", bundle])
    except subprocess.CalledProcessError as error: raise ValueError(f"codesign verification failed for {bundle}: {error.stderr.strip()}") from error
    return BundleIdentity(str(bundle), version, sha256(desktop), {name: sha256(macos / name) for name in REQUIRED_SIDECARS}, bundle_id)


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as stream:
        json.dump(value, stream, indent=2, sort_keys=True); stream.write("\n"); stream.flush(); os.fsync(stream.fileno()); temporary = Path(stream.name)
    os.replace(temporary, path); os.chmod(path, 0o600)


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists(): return None
    with path.open(encoding="utf-8") as stream: value = json.load(stream)
    return value if isinstance(value, dict) else None


@contextmanager
def build_lock(paths: InstallPaths) -> Iterator[None]:
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    try: descriptor = os.open(paths.lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error: raise ValueError(f"another build, promotion, rollback, or cleanup owns {paths.lock}") from error
    try: os.write(descriptor, f"pid={os.getpid()}\n".encode()); yield
    finally: os.close(descriptor); paths.lock.unlink(missing_ok=True)


def exact_stage_errors(repo: Path, sha: str, worktrees: Sequence[Worktree], paths: InstallPaths) -> list[str]:
    errors = ensure_disk_floor(repo)
    if not SHA.fullmatch(sha): return errors + ["stage requires a full immutable 40-character commit SHA, not a branch or tag"]
    resolved = git(repo, ["rev-parse", "--verify", f"{sha}^{{commit}}"], check=False)
    if resolved.returncode or resolved.stdout.strip() != sha: errors.append("the requested SHA does not resolve exactly to a local commit")
    if git(repo, ["rev-parse", "HEAD"]).stdout.strip() != sha: errors.append("the source checkout is not at the requested exact SHA")
    if git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.strip(): errors.append("the source checkout is dirty")
    if not git(repo, ["branch", "-r", "--contains", sha], check=False).stdout.strip(): errors.append("the requested SHA is not pushed to an origin remote ref")
    if sum(not item.primary for item in worktrees) > MAX_AUXILIARY_WORKTREES: errors.append("the registered worktree budget is breached")
    if paths.candidate.exists() or paths.candidate.is_symlink(): errors.append(f"a candidate already exists: {paths.candidate}")
    if paths.journal.exists(): errors.append(f"a transaction recovery journal is pending: {paths.journal}")
    return errors


def hosted_ci_green(repo: Path, sha: str) -> bool:
    remote = git(repo, ["remote", "get-url", "origin"], check=False).stdout.strip(); match = re.search(r"(?:github\.com[:/])([^/]+/[^/.]+)(?:\.git)?$", remote)
    if not match: return False
    result = subprocess.run(["gh", "run", "list", "--repo", match.group(1), "--workflow", "ci.yml", "--commit", sha, "--limit", "20", "--json", "conclusion,headSha"], text=True, capture_output=True)
    if result.returncode: return False
    try: runs = json.loads(result.stdout)
    except json.JSONDecodeError: return False
    return any(run.get("headSha") == sha and run.get("conclusion") == "success" for run in runs if isinstance(run, dict))


def copy_candidate(source: Path, candidate: Path) -> None:
    candidate.parent.mkdir(parents=True, exist_ok=True); temporary = candidate.with_name(f".{candidate.name}.staging")
    if temporary.exists(): raise ValueError(f"stale candidate staging path exists: {temporary}")
    shutil.copytree(source, temporary, symlinks=True); os.replace(temporary, candidate)


def write_journal(paths: InstallPaths, action: str, step: str, identity: BundleIdentity) -> None: atomic_json(paths.journal, {"action": action, "step": step, "identity": asdict(identity), "at": datetime.now(timezone.utc).isoformat()})
def maybe_interrupt(step: str) -> None:
    if os.environ.get("BUZZFORK_INJECT_INTERRUPT_AFTER") == step: raise RuntimeError(f"injected interruption after {step}")
def atomic_move(source: Path, destination: Path) -> None:
    if source.stat().st_dev != destination.parent.stat().st_dev: raise ValueError(f"refusing cross-filesystem move from {source} to {destination.parent}")
    os.replace(source, destination)
def remove_exact_bundle(path: Path, *, inspector=processes_using_path) -> None:
    errors = path_process_errors([path], inspector=inspector)
    if errors: raise ValueError("; ".join(errors))
    if path.exists(): shutil.rmtree(path)


def write_install_manifest(paths: InstallPaths, identity: BundleIdentity, *, fork_sha: str | None = None) -> None:
    old = read_json(paths.manifest) or {}
    atomic_json(paths.manifest, {"fork_commit": fork_sha or old.get("fork_commit"), "upstream_commit_or_tag": old.get("upstream_commit_or_tag"), "app_version": identity.version, "bundle_path": str(paths.stable), "bundle_id": identity.bundle_id, "desktop_sha256": identity.executable_hash, "sidecars_sha256": identity.sidecar_hashes, "promoted_at": datetime.now(timezone.utc).isoformat(), "rollback_identity": old.get("live_identity"), "live_identity": {"version": identity.version, "desktop_sha256": identity.executable_hash, "sidecars_sha256": identity.sidecar_hashes}})


def recover_transaction(paths: InstallPaths, *, inspector=processes_using_path) -> None:
    journal = read_json(paths.journal)
    if not journal: return
    errors = path_process_errors([paths.stable, paths.previous, paths.candidate, paths.prestage, paths.retired, paths.displaced], inspector=inspector)
    if errors: raise ValueError("cannot recover while processes use an install slot: " + "; ".join(errors))
    action, step = journal.get("action"), journal.get("step")
    if action == "promote":
        if step in ("prepared", "previous_retired", "candidate_prestaged"):
            if paths.prestage.exists() and not paths.candidate.exists(): atomic_move(paths.prestage, paths.candidate)
            if paths.retired.exists() and not paths.previous.exists(): atomic_move(paths.retired, paths.previous)
        elif step == "stable_saved":
            if not paths.stable.exists() and paths.previous.exists(): atomic_move(paths.previous, paths.stable)
            if paths.prestage.exists() and not paths.candidate.exists(): atomic_move(paths.prestage, paths.candidate)
            if paths.retired.exists() and not paths.previous.exists(): atomic_move(paths.retired, paths.previous)
        elif step == "promoted":
            if not paths.stable.exists(): raise ValueError("promotion recovery cannot find a runnable stable slot")
            if paths.retired.exists(): remove_exact_bundle(paths.retired, inspector=inspector)
            write_install_manifest(paths, validate_bundle(paths.stable))
        else: raise ValueError(f"unknown promotion recovery step: {step}")
    elif action == "rollback":
        if step in ("prepared", "stable_displaced"):
            if not paths.stable.exists() and paths.displaced.exists(): atomic_move(paths.displaced, paths.stable)
            elif paths.stable.exists() and paths.displaced.exists() and not paths.previous.exists(): atomic_move(paths.displaced, paths.previous)
        elif step == "rolled_back":
            if not paths.stable.exists(): raise ValueError("rollback recovery cannot find a runnable stable slot")
            if paths.displaced.exists() and not paths.previous.exists(): atomic_move(paths.displaced, paths.previous)
            write_install_manifest(paths, validate_bundle(paths.stable))
        else: raise ValueError(f"unknown rollback recovery step: {step}")
    else: raise ValueError(f"unknown transaction action: {action}")
    paths.journal.unlink(missing_ok=True)


def command_status(args: argparse.Namespace) -> int:
    root = repo_root(args.repo); print_status(inspect_worktrees(root), root, install_paths()); return 0
def command_cargo_target(_args: argparse.Namespace) -> int: print(default_cargo_target()); return 0
def command_build(args: argparse.Namespace) -> int:
    root = repo_root(args.repo); os.environ["CARGO_TARGET_DIR"] = str(default_cargo_target()); print(f"buzzfork-dev: shared Cargo target {default_cargo_target()}"); return run_guarded(args.command, root)


def command_create(args: argparse.Namespace) -> int:
    root, worktrees, destination = repo_root(args.repo), inspect_worktrees(args.repo), args.path.expanduser().resolve()
    errors = create_errors(worktrees, disk_path=root, destination=destination, branch_valid=git(root, ["check-ref-format", "--branch", args.branch], check=False).returncode == 0, branch_exists=git(root, ["show-ref", "--verify", f"refs/heads/{args.branch}"], check=False).returncode == 0 or git(root, ["show-ref", "--verify", f"refs/remotes/origin/{args.branch}"], check=False).returncode == 0, base_exists=git(root, ["rev-parse", "--verify", f"{args.base}^{{commit}}"], check=False).returncode == 0)
    if errors: return report_refusal(errors)
    command = ["git", "-C", root, "worktree", "add", "-b", args.branch, "--", destination, args.base]; print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: {quote_command(command)}")
    if args.execute: subprocess.run([str(part) for part in command], check=True)
    return 0


def command_finish(args: argparse.Namespace) -> int:
    root, worktrees, requested = repo_root(args.repo), inspect_worktrees(args.repo), args.worktree.expanduser().resolve(); worktree = next((item for item in worktrees if item.path == requested), None); errors = finish_errors(worktree)
    if errors: return report_refusal(errors)
    assert worktree; primary = next(item for item in worktrees if item.primary); remove, prune = ["git", "-C", primary.path, "worktree", "remove", worktree.path], ["git", "-C", primary.path, "worktree", "prune"]
    print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: {quote_command(remove)}\nbuzzfork-dev: {'execute' if args.execute else 'dry-run'}: {quote_command(prune)}")
    if args.execute: subprocess.run([str(part) for part in remove], check=True); subprocess.run([str(part) for part in prune], check=True)
    return 0


def command_stage(args: argparse.Namespace) -> int:
    root, paths = repo_root(args.repo), install_paths(); errors = exact_stage_errors(root, args.sha, inspect_worktrees(root), paths)
    if errors: return report_refusal(errors)
    if not hosted_ci_green(root, args.sha): return report_refusal(["hosted CI has not succeeded for this exact pushed SHA"])
    source = args.bundle.expanduser().resolve() if args.bundle else default_cargo_target() / "aarch64-apple-darwin/release/bundle/macos/Buzz.app"; print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: validate {source} and stage one candidate at {paths.candidate}")
    if not args.execute: return 0
    with build_lock(paths):
        if not args.bundle:
            os.environ["CARGO_TARGET_DIR"] = str(default_cargo_target())
            if run_guarded(["cargo", "fmt", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--all", "--", "--check"], root) != 0: return 1
            if run_guarded(["just", "desktop-release-build"], root) != 0: return 1
        identity = validate_bundle(source); copy_candidate(source, paths.candidate); copied = validate_bundle(paths.candidate)
        if copied.executable_hash != identity.executable_hash or copied.sidecar_hashes != identity.sidecar_hashes: remove_exact_bundle(paths.candidate); return report_refusal(["candidate hashes differ from the validated package"])
        atomic_json(paths.state_dir / "candidate-state.json", {"fork_commit": args.sha, "identity": asdict(copied), "packaging_output": str(source)})
    return 0


def command_promote(args: argparse.Namespace) -> int:
    paths = install_paths()
    if not paths.candidate.exists(): return report_refusal([f"no candidate exists at {paths.candidate}"])
    promotion_slots = [paths.stable, paths.candidate, paths.previous, paths.prestage, paths.retired]
    errors = stopped_buzz_errors(promotion_slots)
    if errors: return report_refusal(errors + ["quit Buzz and every bundled harness yourself; this command never stops them automatically"])
    identity = validate_bundle(paths.candidate); print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: promote {paths.candidate} to {paths.stable}, retaining one rollback at {paths.previous}")
    if not args.execute: return 0
    with build_lock(paths):
        errors = stopped_buzz_errors(promotion_slots)
        if errors: return report_refusal(errors + ["quit Buzz and every bundled harness yourself; this command never stops them automatically"])
        recover_transaction(paths)
        if not paths.stable.exists(): return report_refusal([f"live stable app is missing: {paths.stable}"])
        if paths.prestage.exists() or paths.retired.exists(): return report_refusal(["a stale promotion staging slot exists; recover it before promotion"])
        write_journal(paths, "promote", "prepared", identity)
        if paths.previous.exists():
            atomic_move(paths.previous, paths.retired)
            write_journal(paths, "promote", "previous_retired", identity)
            maybe_interrupt("previous_retired")
        atomic_move(paths.candidate, paths.prestage); write_journal(paths, "promote", "candidate_prestaged", identity); maybe_interrupt("candidate_prestaged")
        atomic_move(paths.stable, paths.previous); write_journal(paths, "promote", "stable_saved", identity); maybe_interrupt("stable_saved")
        atomic_move(paths.prestage, paths.stable); write_journal(paths, "promote", "promoted", identity); maybe_interrupt("promoted")
        if paths.retired.exists(): remove_exact_bundle(paths.retired)
        write_install_manifest(paths, identity, fork_sha=(read_json(paths.state_dir / "candidate-state.json") or {}).get("fork_commit")); paths.journal.unlink(missing_ok=True)
    return 0


def command_verify(args: argparse.Namespace) -> int:
    paths = install_paths(); manifest = read_json(paths.manifest)
    if not manifest: return report_refusal([f"install state is missing: {paths.manifest}"])
    try: identity = validate_bundle(paths.stable)
    except ValueError as error: return report_refusal([str(error)])
    errors = []
    if manifest.get("bundle_path") != str(paths.stable): errors.append("install state does not name the canonical stable path")
    if manifest.get("desktop_sha256") != identity.executable_hash or manifest.get("sidecars_sha256") != identity.sidecar_hashes: errors.append("live executable or sidecar hashes do not match install state")
    running = processes_using_path(paths.stable)
    if not running.available: errors.append(f"cannot prove running executable path: {running.detail}")
    elif not any(path == paths.stable / "Contents/MacOS" / DESKTOP_EXECUTABLE for path in running.paths): errors.append(f"no running desktop executable is under {paths.stable}; relaunch from the canonical stable path before verification")
    if errors: return report_refusal(errors)
    print(f"buzzfork-dev: verified {paths.stable} version {identity.version} with matching bundled sidecars"); return 0


def command_rollback(args: argparse.Namespace) -> int:
    paths = install_paths()
    if not paths.stable.exists() or not paths.previous.exists(): return report_refusal(["rollback requires both the live and previous app slots"])
    rollback_slots = [paths.stable, paths.previous, paths.displaced]
    errors = stopped_buzz_errors(rollback_slots)
    if errors: return report_refusal(errors + ["quit Buzz and every bundled harness yourself; this command never stops them automatically"])
    identity = validate_bundle(paths.previous); print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: restore {paths.previous} to {paths.stable}")
    if not args.execute: return 0
    with build_lock(paths):
        errors = stopped_buzz_errors(rollback_slots)
        if errors: return report_refusal(errors + ["quit Buzz and every bundled harness yourself; this command never stops them automatically"])
        recover_transaction(paths); write_journal(paths, "rollback", "prepared", identity); atomic_move(paths.stable, paths.displaced); write_journal(paths, "rollback", "stable_displaced", identity); maybe_interrupt("stable_displaced")
        atomic_move(paths.previous, paths.stable); atomic_move(paths.displaced, paths.previous); write_journal(paths, "rollback", "rolled_back", identity); maybe_interrupt("rolled_back")
        write_install_manifest(paths, identity); paths.journal.unlink(missing_ok=True)
    return 0


def command_accept(args: argparse.Namespace) -> int:
    paths = install_paths(); candidates = [path for path in (paths.candidate, paths.retired, paths.prestage, paths.displaced) if path.exists()]; print(f"buzzfork-dev: {'execute' if args.execute else 'dry-run'}: remove consumed candidate and temporary packaging output; retain {paths.previous}")
    if not args.execute: return 0
    with build_lock(paths):
        recover_transaction(paths)
        for path in candidates: remove_exact_bundle(path)
        candidate_state = paths.state_dir / "candidate-state.json"; record = read_json(candidate_state) or {}; packaging = record.get("packaging_output")
        if packaging and (output := Path(packaging)).name == "Buzz.app": remove_exact_bundle(output)
        candidate_state.unlink(missing_ok=True)
    return 0


def destructive_mode(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(); mode.add_argument("--dry-run", action="store_true", help="preview only (the default)"); mode.add_argument("--execute", action="store_true", help="perform the displayed operation")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--repo", type=Path, default=Path.cwd(), help="any checkout or worktree for this repository"); commands = parser.add_subparsers(dest="subcommand", required=True)
    status = commands.add_parser("status", help="report worktrees, disk, and desktop slots"); status.set_defaults(handler=command_status)
    cargo = commands.add_parser("cargo-target", help="print the shared Cargo target"); cargo.set_defaults(handler=command_cargo_target)
    build = commands.add_parser("build", help="run a command with the disk guard and shared Cargo target"); build.add_argument("command", nargs=argparse.REMAINDER); build.set_defaults(handler=command_build)
    create = commands.add_parser("create", help="preflight and optionally create an auxiliary worktree"); create.add_argument("path", type=Path); create.add_argument("branch"); create.add_argument("--base", default="origin/main"); destructive_mode(create); create.set_defaults(handler=command_create)
    finish = commands.add_parser("finish", help="remove only a clean, pushed, inactive worktree"); finish.add_argument("worktree", type=Path); destructive_mode(finish); finish.set_defaults(handler=command_finish)
    stage = commands.add_parser("stage", help="validate and stage one exact-head candidate outside worktrees"); stage.add_argument("sha", help="full immutable 40-character commit SHA"); stage.add_argument("--bundle", type=Path, help="already-packaged Buzz.app"); destructive_mode(stage); stage.set_defaults(handler=command_stage)
    promote = commands.add_parser("promote", help="transactionally promote the staged candidate"); destructive_mode(promote); promote.set_defaults(handler=command_promote)
    verify = commands.add_parser("verify", help="prove the relaunched canonical app matches install state"); verify.set_defaults(handler=command_verify)
    rollback = commands.add_parser("rollback", help="transactionally restore the single rollback app"); destructive_mode(rollback); rollback.set_defaults(handler=command_rollback)
    accept = commands.add_parser("accept", help="remove consumed candidate/package output and retain one rollback"); destructive_mode(accept); accept.set_defaults(handler=command_accept)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser(); args = parser.parse_args(argv)
    if args.subcommand == "build":
        if args.command[:1] == ["--"]: args.command = args.command[1:]
        if not args.command: parser.error("build requires a command after --")
    try: return int(args.handler(args))
    except (OSError, ValueError, subprocess.CalledProcessError) as error: print(f"buzzfork-dev: {error}", file=sys.stderr); return 1


if __name__ == "__main__": raise SystemExit(main())
