import shutil
import subprocess
import tempfile
import platform
from pathlib import Path

from .config import RUNTIME_DIR
from .systemd import stop_services, remove_units

def shlex_quote(value):
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _schedule_self_uninstall():
    if platform.system() == "Windows":
        script_path = Path(tempfile.gettempdir()) / "agentautoupdate-uninstall.cmd"
        script_path.write_text(
            f"@echo off\r\n"
            f"ping 127.0.0.1 -n 3 >NUL\r\n"
            f"rmdir /S /Q \"{RUNTIME_DIR}\"\r\n"
            f"del /F /Q \"%~f0\"\r\n",
            encoding="utf-8",
        )
        subprocess.Popen(
            ["cmd.exe", "/c", str(script_path)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return

    script_content = f"""#!/bin/sh
set -eu
sleep 2
rm -rf {shlex_quote(str(RUNTIME_DIR))}
rm -f "$0"
"""
    script_path = Path(tempfile.gettempdir()) / "agentautoupdate-uninstall.sh"
    script_path.write_text(script_content, encoding="utf-8")
    script_path.chmod(0o700)
    subprocess.Popen(
        ["/bin/sh", str(script_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def uninstall_agent(stop_running=True):
    if stop_running:
        stop_services()
        remove_units()
        if RUNTIME_DIR.exists():
            shutil.rmtree(RUNTIME_DIR, ignore_errors=True)
        return

    stop_services()
    remove_units()
    _schedule_self_uninstall()
