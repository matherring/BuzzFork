#!/usr/bin/env python3
"""Enforce BuzzFork's local-build disk floor before and during a command."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import sys
import time
from typing import NoReturn


MIN_FREE_BYTES = 50 * 1024**3
POLL_INTERVAL_SECONDS = 1.0
TERMINATE_GRACE_SECONDS = 10.0
DISK_GUARD_EXIT = 75


def free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


def format_gib(value: int) -> str:
    return f"{value / 1024**3:.1f} GiB"


def disk_failure(message: str) -> NoReturn:
    print(f"buzzfork-build-guard: {message}", file=sys.stderr, flush=True)
    raise SystemExit(DISK_GUARD_EXIT)


def require_disk_floor(path: Path) -> int:
    try:
        available = free_bytes(path)
    except OSError as error:
        disk_failure(f"cannot measure free space for {path}: {error}")
    if available < MIN_FREE_BYTES:
        disk_failure(
            f"refusing to start: {format_gib(available)} free on {path}; "
            f"the floor is {format_gib(MIN_FREE_BYTES)}"
        )
    return available


def terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=TERMINATE_GRACE_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()


def run_guarded(command: list[str], path: Path) -> int:
    available = require_disk_floor(path)
    print(
        "buzzfork-build-guard: "
        f"{format_gib(available)} free; floor {format_gib(MIN_FREE_BYTES)}; "
        f"running {shlex.join(command)}",
        flush=True,
    )
    try:
        process = subprocess.Popen(command, start_new_session=True)
    except FileNotFoundError:
        print(
            f"buzzfork-build-guard: command not found: {command[0]}",
            file=sys.stderr,
        )
        return 127

    try:
        while process.poll() is None:
            time.sleep(POLL_INTERVAL_SECONDS)
            try:
                available = free_bytes(path)
            except OSError as error:
                print(
                    f"buzzfork-build-guard: cannot measure free space: {error}; "
                    "terminating guarded command",
                    file=sys.stderr,
                    flush=True,
                )
                terminate_process_group(process)
                return DISK_GUARD_EXIT
            if available < MIN_FREE_BYTES:
                print(
                    "buzzfork-build-guard: disk floor breached "
                    f"({format_gib(available)} free; floor "
                    f"{format_gib(MIN_FREE_BYTES)}); terminating guarded command",
                    file=sys.stderr,
                    flush=True,
                )
                terminate_process_group(process)
                return DISK_GUARD_EXIT
    except KeyboardInterrupt:
        terminate_process_group(process)
        return 130

    return process.returncode


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run a local BuzzFork build/test/package command behind a 50 GiB "
            "disk floor."
        )
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="check the disk floor without starting a command",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command[:1] == ["--"]:
        args.command = args.command[1:]
    if args.check_only and args.command:
        parser.error("--check-only does not accept a command")
    if not args.check_only and not args.command:
        parser.error("pass a command after --, or use --check-only")
    return args


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    if args.check_only:
        available = require_disk_floor(repo_root)
        print(
            "buzzfork-build-guard: "
            f"PASS — {format_gib(available)} free; "
            f"floor {format_gib(MIN_FREE_BYTES)}",
        )
        return 0
    return run_guarded(args.command, repo_root)


if __name__ == "__main__":
    raise SystemExit(main())
