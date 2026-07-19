import json
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PreflightTests(unittest.TestCase):
    def test_preflight_is_green_and_read_only(self) -> None:
        completed = subprocess.run(
            [sys.executable, "scripts/lh_preflight.py"],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        result = json.loads(completed.stdout)
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["driver"], "loop-hybrid")
        self.assertFalse(result["writes_repo"])

    def test_preflight_does_not_modify_workflow_files(self) -> None:
        manifest = ROOT / "workflow/engine-manifest.json"
        before = manifest.read_bytes()
        subprocess.run([sys.executable, "scripts/lh_preflight.py"], cwd=ROOT, check=True)
        self.assertEqual(before, manifest.read_bytes())


if __name__ == "__main__":
    unittest.main()
