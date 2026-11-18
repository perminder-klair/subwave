"""Run with python3 prep-worktree.test.py; requires Git, Bash and Docker Compose.

Uses actual prep and Compose parsing in temporary Git worktrees, without starting
containers or reading any operator configuration.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("prep-worktree.sh")
REPO = SCRIPT.parents[4]


class PrepWorktreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="subwave-prep-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        private_home = self.base / "home"
        private_home.mkdir()
        self.env = {
            "PATH": os.environ["PATH"],
            "HOME": str(private_home),
            "TMPDIR": str(self.base),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
        }
        self.main = self.base / "main"
        self.target = self.base / "worktree"
        self.run_command(["git", "init", "--quiet", str(self.main)])
        for name in ["controller", "web", "docker"]:
            directory = self.main / name
            directory.mkdir()
            (directory / ".gitkeep").touch()
        shutil.copyfile(REPO / "docker-compose.dev.yml", self.main / "docker-compose.dev.yml")
        self.run_command(["git", "-C", str(self.main), "add", "."])
        self.run_command([
            "git", "-C", str(self.main), "-c", "user.name=Fixture",
            "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture",
        ])
        self.run_command([
            "git", "-C", str(self.main), "worktree", "add", "--quiet",
            "--detach", str(self.target), "HEAD",
        ])
        self.root = "ADMIN_USER=root\nADMIN_PASS=rootpass\nSITE_URL=http://localhost:7700"
        (self.main / ".env").write_text(self.root)

    def run_command(self, args, **kwargs):
        result = subprocess.run(
            args, env=self.env, cwd=self.base, capture_output=True, text=True, **kwargs,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def legacy(self, text):
        (self.main / "controller/.env").write_text(text)

    def prep(self, host="localhost"):
        source = self.snapshot(self.main, exclude_git=True)
        self.env["SUBWAVE_DEV_HOST"] = host
        self.run_command(["bash", str(SCRIPT), "--skip-npm", str(self.target)])
        self.assertEqual(self.snapshot(self.main, exclude_git=True), source)
        prepared = self.snapshot(self.target)
        self.run_command(["bash", str(SCRIPT), "--skip-npm", str(self.target)])
        self.assertEqual(self.snapshot(self.target), prepared, "rerun changed file contents")

    @staticmethod
    def snapshot(directory, exclude_git=False):
        return {
            str(path.relative_to(directory)): path.read_bytes()
            for path in directory.rglob("*")
            if path.is_file() and not (exclude_git and ".git" in path.relative_to(directory).parts)
        }

    def compose(self, env_file=None, project_env=None):
        compose_file = self.target / "docker-compose.dev.yml"
        default_env = self.target / ".env"
        if env_file is not None:
            default_env = self.main / ".env" if (self.main / ".env").exists() else env_file
            compose_file = self.base / "source-compose.yml"
            compose_file.write_text(
                "services:\n  controller:\n    image: scratch\n    env_file:\n      - "
                + json.dumps(str(env_file)) + "\n"
            )
        output = self.run_command([
            "docker", "compose", "--project-name", "prep-regression",
            "--project-directory", str(self.target), "--env-file", str(project_env or default_env),
            "-f", str(compose_file), "config", "--format", "json",
        ])
        return json.loads(output)["services"]

    def test_root_precedence_normalizes_export_and_whitespace(self):
        root = " export ADMIN_PASS = rootpass\nEMPTY =\n"
        (self.target / ".env").write_text(root)
        self.legacy("ADMIN_PASS=legacy\n export EMPTY = legacy\n  NAVIDROME_USER = user\n")
        self.prep()
        self.assertTrue((self.target / ".env").read_text().startswith(root))
        values = self.compose()["controller"]["environment"]
        self.assertEqual(values["ADMIN_PASS"], "rootpass")
        self.assertEqual(values["EMPTY"], "")
        self.assertEqual(values["NAVIDROME_USER"], "user")

    def test_icecast_exclusions_normalize_export_and_whitespace(self):
        self.legacy(
            "export ICECAST_SOURCE_PASSWORD=legacy\n"
            "  ICECAST_ADMIN_PASSWORD = legacy\n\t export ICECAST_RELAY_PASSWORD=legacy\n"
            "NAVIDROME_USER=user\n"
        )
        self.prep()
        services = self.compose()
        for key in ["ICECAST_SOURCE_PASSWORD", "ICECAST_ADMIN_PASSWORD", "ICECAST_RELAY_PASSWORD"]:
            self.assertNotIn(key, services["controller"]["environment"])
            self.assertEqual(services["broadcast"]["environment"][key], "")

    def test_duplicate_assignments_keep_last_value_and_interpolation_order(self):
        text = (
            "NAVIDROME_URL=http://stale:4533\nBEFORE=${NAVIDROME_URL}\n"
            "NAVIDROME_URL=http://current:4533\nAFTER=${NAVIDROME_URL}\n"
        )
        self.legacy(text)
        self.prep()
        # Root .env is read both for project substitution and as env_file. Compare
        # to the same unmodified assignments in that context, not a legacy-only
        # env_file that does not also supply project substitution variables.
        reference = self.base / "reference.env"
        reference.write_text(self.root + "\n" + text)
        expected = self.compose(reference, project_env=reference)["controller"]["environment"]
        actual = self.compose()["controller"]["environment"]
        for key in ["NAVIDROME_URL", "BEFORE", "AFTER"]:
            self.assertEqual(actual[key], expected[key])
        self.assertEqual(actual["NAVIDROME_URL"], "http://current:4533")
        self.assertIn(text, (self.target / ".env").read_text())

    def test_multiline_values_and_escaped_quotes_are_complete_records(self):
        text = (
            "NAVIDROME_PASS='first\nNAVIDROME_USER=inside-value\n"
            "ICECAST_SOURCE_PASSWORD=inside-value\n# literal comment\nlast'\n"
            'DOUBLE="first \\"quoted\\"\nsecond" # comment with a quote\n'
            "SINGLE='can\\'t\nstop'\n"
            'BACKSLASH="two\\\\"\nNEXT=value\n'
        )
        self.legacy(text)
        self.prep()
        expected = self.compose(self.main / "controller/.env")["controller"]["environment"]
        actual = self.compose()["controller"]["environment"]
        for key, value in expected.items():
            self.assertEqual(actual[key], value)
        self.assertNotIn("NAVIDROME_USER", actual)
        self.assertNotIn("ICECAST_SOURCE_PASSWORD", actual)
        self.assertIn(text, (self.target / ".env").read_text())

    def test_assignment_text_inside_root_multiline_does_not_claim_a_key(self):
        root = "DOCUMENT='first\nNAVIDROME_USER=not-an-assignment\nlast'\n"
        (self.target / ".env").write_text(root)
        self.legacy("NAVIDROME_USER=real-user\n")
        self.prep()
        self.assertEqual(self.compose()["controller"]["environment"]["NAVIDROME_USER"], "real-user")
        self.assertTrue((self.target / ".env").read_text().startswith(root))

    def test_literal_values_are_never_executed_or_requoted(self):
        sentinel = self.base / "must-not-exist"
        text = (
            f"NAVIDROME_PASS='$(touch {sentinel})'\n"
            "LITERAL='${MISSING:-literal} # hash'\n"
            'EXPANDED="${ADMIN_PASS}-suffix"\n'
        )
        self.legacy(text)
        self.prep()
        expected = self.compose(self.main / "controller/.env")["controller"]["environment"]
        actual = self.compose()["controller"]["environment"]
        self.assertFalse(sentinel.exists())
        self.assertEqual(actual["NAVIDROME_PASS"], expected["NAVIDROME_PASS"])
        self.assertEqual(actual["LITERAL"], expected["LITERAL"])
        self.assertEqual(actual["EXPANDED"], "rootpass-suffix")
        self.assertIn(text, (self.target / ".env").read_text())

    def test_missing_root_and_crlf_without_final_newline(self):
        (self.main / ".env").unlink()
        text = "# comment\r\n export NAVIDROME_USER = user\r\nNAVIDROME_PASS='pass'"
        (self.main / "controller/.env").write_bytes(text.encode())
        self.prep()
        values = self.compose()["controller"]["environment"]
        self.assertEqual(values["NAVIDROME_USER"], "user")
        self.assertEqual(values["NAVIDROME_PASS"], "pass")

    def test_comments_only_legacy_does_not_change_root_without_final_newline(self):
        self.legacy("# NAVIDROME_PASS=comment\n\n   # export ADMIN_PASS=comment\n")
        self.prep()
        self.assertEqual((self.target / ".env").read_text(), self.root)
        self.assertEqual(self.compose()["controller"]["environment"]["ADMIN_PASS"], "rootpass")

    def test_unterminated_quote_does_not_append_partial_records_or_log_values(self):
        self.legacy("NAVIDROME_USER=user\nNAVIDROME_PASS='secret-without-closing-quote\n")
        result = subprocess.run(
            ["bash", str(SCRIPT), "--skip-npm", str(self.target)],
            env=self.env, cwd=self.base, capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unterminated quoted dotenv value", result.stderr)
        self.assertNotIn("secret-without-closing-quote", result.stdout + result.stderr)
        self.assertEqual((self.target / ".env").read_text(), self.root)

    def test_web_config_is_scaffolded_only_when_absent(self):
        self.prep(host="100.1.2.3")
        web_env = self.target / "web/.env.local"
        self.assertEqual(web_env.read_text(),
                         "NEXT_PUBLIC_API_URL=http://100.1.2.3:7701\n"
                         "NEXT_PUBLIC_STREAM_URL=http://100.1.2.3:7702/stream.mp3\n")
        (self.main / "web/.env.local").write_text("NEXT_PUBLIC_API_URL=http://copied:7701\n")
        self.prep(host="localhost")
        self.assertIn("100.1.2.3", web_env.read_text())
        web_env.unlink()
        self.prep()
        self.assertEqual(web_env.read_bytes(), (self.main / "web/.env.local").read_bytes())


if __name__ == "__main__":
    unittest.main()
