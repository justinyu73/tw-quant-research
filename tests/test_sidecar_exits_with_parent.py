"""The desktop shell cannot reap the sidecar on a crash or a force quit.

A surviving sidecar keeps its own executable open, and the next Windows install
then fails with "unable to automatically close all requested applications" —
observed on v0.3.1 with three orphaned tqe-sidecar.exe from two install roots.
"""
from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SIDECAR = ROOT / "scripts" / "tqe_sidecar.py"


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


class SidecarParentExitTest(unittest.TestCase):
    """Kill the parent the way a crash does — no chance to run any handler."""

    def _run(self, extra_args: list[str]) -> bool:
        port = _free_port()
        launcher = (
            "import subprocess,sys,time;"
            f"child=subprocess.Popen([sys.executable,{str(SIDECAR)!r},'--port',{str(port)!r}]+{extra_args!r},"
            "stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);"
            "print(child.pid,flush=True);time.sleep(600)"
        )
        parent = subprocess.Popen([sys.executable, "-c", launcher], stdout=subprocess.PIPE, text=True)
        try:
            child_pid = int(parent.stdout.readline().strip())
            ready = False
            for _ in range(120):
                try:
                    urllib.request.urlopen(f"http://127.0.0.1:{port}/instruments", timeout=1)
                    ready = True
                    break
                except Exception:
                    time.sleep(0.25)
            self.assertTrue(ready, "sidecar never became ready, so nothing was measured")
        finally:
            os.kill(parent.pid, signal.SIGKILL)
            parent.wait()

        for _ in range(40):
            if not _alive(child_pid):
                return False
            time.sleep(0.25)
        os.kill(child_pid, signal.SIGKILL)
        return True

    def test_orphans_without_the_flag(self) -> None:
        # Guards the guard: if this ever stops orphaning, the test below proves
        # nothing and would pass on any build.
        self.assertTrue(self._run([]), "expected an orphan without --exit-with-parent")

    def test_exits_with_parent(self) -> None:
        self.assertFalse(self._run(["--exit-with-parent"]), "sidecar outlived its parent")


class WindowsInstallerReapsOrphansTest(unittest.TestCase):
    """The app-side fix cannot help with orphans an older build already left
    running, and those are exactly what blocks an install or an uninstall.
    zibaldone hit the same thing and solved it with an NSIS pre-install hook;
    TQR never had one."""

    def test_nsis_hooks_kill_the_sidecar(self) -> None:
        import json

        config = json.loads((ROOT / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
        nsis = config["bundle"]["windows"]["nsis"]
        hooks_name = nsis["installerHooks"]
        hooks = (ROOT / "frontend/src-tauri" / hooks_name).read_text(encoding="utf-8")
        for macro in ("NSIS_HOOK_PREINSTALL", "NSIS_HOOK_PREUNINSTALL"):
            self.assertIn(macro, hooks, f"{hooks_name} has no {macro}")
        self.assertIn("tqe-sidecar.exe", hooks, "the hook does not name the sidecar it must kill")


if __name__ == "__main__":
    unittest.main()
