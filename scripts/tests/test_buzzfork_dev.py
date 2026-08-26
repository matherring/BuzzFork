from __future__ import annotations

import argparse
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import buzzfork_dev  # noqa: E402


GIB = 1024**3


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()


class PureChecksTest(unittest.TestCase):
    def test_parse_worktree_porcelain(self) -> None:
        parsed = buzzfork_dev.parse_worktree_porcelain(
            "worktree /repo\n"
            "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
            "branch refs/heads/main\n\n"
            "worktree /repo-canary\n"
            "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n"
            "detached\n"
        )
        self.assertEqual(parsed[0]["worktree"], "/repo")
        self.assertEqual(parsed[0]["branch"], "refs/heads/main")
        self.assertIs(parsed[1]["detached"], True)

    def test_create_rejects_third_auxiliary_and_low_disk(self) -> None:
        worktrees = [
            mock.Mock(primary=True),
            mock.Mock(primary=False),
            mock.Mock(primary=False),
        ]
        with mock.patch.object(
            buzzfork_dev,
            "free_bytes",
            return_value=49 * GIB,
        ):
            errors = buzzfork_dev.create_errors(
                worktrees,
                disk_path=Path("/repo"),
                destination=Path("/path/that/does/not/exist"),
            )
        self.assertTrue(any("50.0 GiB" in error for error in errors))
        self.assertTrue(any("budget is 2" in error for error in errors))

    def test_finish_requires_clean_pushed_branch(self) -> None:
        ready = buzzfork_dev.Worktree(
            path=Path("/repo-impl"),
            head="a" * 40,
            branch="feature",
            primary=False,
            clean=True,
            upstream="origin/feature",
            ahead=0,
            behind=0,
        )
        self.assertEqual(buzzfork_dev.finish_errors(ready), [])
        self.assertTrue(buzzfork_dev.finish_errors(None))
        self.assertTrue(
            buzzfork_dev.finish_errors(
                buzzfork_dev.Worktree(**{**ready.__dict__, "clean": False})
            )
        )
        self.assertTrue(
            buzzfork_dev.finish_errors(
                buzzfork_dev.Worktree(**{**ready.__dict__, "upstream": None})
            )
        )
        self.assertTrue(
            buzzfork_dev.finish_errors(
                buzzfork_dev.Worktree(**{**ready.__dict__, "ahead": 1})
            )
        )

    def test_cargo_target_is_configurable_and_portable(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"BUZZFORK_CARGO_TARGET_DIR": "/tmp/custom-buzzfork-target"},
            clear=False,
        ):
            self.assertEqual(
                buzzfork_dev.default_cargo_target(),
                Path("/tmp/custom-buzzfork-target").resolve(),
            )


class WorktreeIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="buzzfork-dev-test-")
        root = Path(self.temp.name)
        self.remote = root / "remote.git"
        self.repo = root / "repo"
        self.implementation = root / "implementation"
        self.canary = root / "canary"
        self.third = root / "third"

        subprocess.run(
            ["git", "init", "--bare", str(self.remote)],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "init", "--initial-branch=main", str(self.repo)],
            check=True,
            capture_output=True,
        )
        git(self.repo, "config", "user.name", "BuzzFork Dev Test")
        git(self.repo, "config", "user.email", "test@example.invalid")
        (self.repo / "README.md").write_text("test\n", encoding="utf-8")
        git(self.repo, "add", "README.md")
        git(self.repo, "commit", "-m", "initial")
        git(self.repo, "remote", "add", "origin", str(self.remote))
        git(self.repo, "push", "-u", "origin", "main")
        git(
            self.repo,
            "worktree",
            "add",
            "-b",
            "implementation",
            str(self.implementation),
        )
        git(self.implementation, "push", "-u", "origin", "implementation")

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_inspection_reports_upstream_and_cleanliness(self) -> None:
        worktrees = buzzfork_dev.inspect_worktrees(self.repo)
        self.assertEqual(len(worktrees), 2)
        self.assertTrue(worktrees[0].primary)
        self.assertEqual(worktrees[1].branch, "implementation")
        self.assertEqual(worktrees[1].upstream, "origin/implementation")
        self.assertEqual(worktrees[1].ahead, 0)
        self.assertTrue(worktrees[1].clean)

    def test_create_defaults_to_dry_run_and_enforces_budget(self) -> None:
        args = argparse.Namespace(
            repo=self.repo,
            path=self.canary,
            branch="canary",
            base="origin/main",
            execute=False,
        )
        with mock.patch.object(buzzfork_dev, "free_bytes", return_value=60 * GIB):
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(buzzfork_dev.command_create(args), 0)
        self.assertFalse(self.canary.exists())

        args.execute = True
        with mock.patch.object(buzzfork_dev, "free_bytes", return_value=60 * GIB):
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(buzzfork_dev.command_create(args), 0)
        self.assertTrue(self.canary.exists())

        over_budget = argparse.Namespace(
            repo=self.repo,
            path=self.third,
            branch="third",
            base="origin/main",
            execute=False,
        )
        with mock.patch.object(buzzfork_dev, "free_bytes", return_value=60 * GIB):
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                with mock.patch("sys.stderr", new_callable=io.StringIO):
                    self.assertEqual(
                        buzzfork_dev.command_create(over_budget),
                        buzzfork_dev.EXIT_REFUSED,
                    )
        self.assertFalse(self.third.exists())

    def test_finish_dry_run_then_execute_preserves_branch(self) -> None:
        args = argparse.Namespace(
            repo=self.repo,
            worktree=self.implementation,
            execute=False,
        )
        with mock.patch.object(buzzfork_dev, "free_bytes", return_value=60 * GIB):
            with mock.patch("sys.stdout", new_callable=io.StringIO) as output:
                self.assertEqual(buzzfork_dev.command_finish(args), 0)
        self.assertIn("dry-run", output.getvalue())
        self.assertTrue(self.implementation.exists())

        args.execute = True
        with mock.patch.object(buzzfork_dev, "free_bytes", return_value=60 * GIB):
            with mock.patch("sys.stdout", new_callable=io.StringIO):
                self.assertEqual(buzzfork_dev.command_finish(args), 0)
        self.assertFalse(self.implementation.exists())
        self.assertEqual(git(self.repo, "rev-parse", "implementation"), git(self.repo, "rev-parse", "origin/implementation"))


if __name__ == "__main__":
    unittest.main()
