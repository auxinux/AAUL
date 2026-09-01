import platform
import subprocess
from pathlib import Path

from .config import APP_DIR, LOG_DIR, RUNTIME_DIR, VENV_DIR

SYSTEM_NAME = platform.system()
LINUX_SERVICE = "agentautoupdate.service"
LINUX_TIMER = "agentautoupdate-run.timer"
LAUNCHD_POLLER_LABEL = "com.agentautoupdate.poller"
LAUNCHD_RUNNER_LABEL = "com.agentautoupdate.runner"
LAUNCHD_POLLER_PLIST = Path("/Library/LaunchDaemons/com.agentautoupdate.poller.plist")
LAUNCHD_RUNNER_PLIST = Path("/Library/LaunchDaemons/com.agentautoupdate.runner.plist")
WINDOWS_POLLER_TASK = "AgentAutoUpdate Poller"
WINDOWS_RUNNER_TASK = "AgentAutoUpdate Runner"


def _run(command):
    subprocess.run(command, check=False)


def _python_executable():
    windows_python = VENV_DIR / "Scripts" / "python.exe"
    unix_python = VENV_DIR / "bin" / "python"
    return windows_python if windows_python.exists() else unix_python


def systemctl(args):
    if SYSTEM_NAME == "Linux":
        _run(["systemctl", *args])


def _launchctl_bootout(target):
    _run(["launchctl", "bootout", "system", str(target)])


def _launchctl_bootstrap(target):
    _run(["launchctl", "bootstrap", "system", str(target)])


def _write_launchd_runner(daily_time):
    hour, minute = daily_time.split(":", 1)
    LAUNCHD_RUNNER_PLIST.write_text(
        f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_RUNNER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{_python_executable()}</string>
    <string>{APP_DIR / "agent_runner.py"}</string>
    <string>--run-once</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>{int(hour)}</integer>
    <key>Minute</key>
    <integer>{int(minute)}</integer>
  </dict>
  <key>WorkingDirectory</key>
  <string>{RUNTIME_DIR}</string>
  <key>StandardOutPath</key>
  <string>{LOG_DIR / "runner.log"}</string>
  <key>StandardErrorPath</key>
  <string>{LOG_DIR / "runner.err"}</string>
</dict>
</plist>
""",
        encoding="utf-8",
    )
    LAUNCHD_RUNNER_PLIST.chmod(0o644)


def _register_windows_task(task_name, script_path, trigger_args, extra_args=None):
    python_cmd = _python_executable()
    command_parts = [f'"{python_cmd}"', f'"{script_path}"']
    if extra_args:
        command_parts.extend(extra_args)
    task_command = " ".join(command_parts)
    _run(
        [
            "schtasks",
            "/Create",
            "/TN",
            task_name,
            "/TR",
            task_command,
            *trigger_args,
            "/RU",
            "SYSTEM",
            "/RL",
            "HIGHEST",
            "/F",
        ]
    )


def set_schedule(enabled, daily_time):
    if SYSTEM_NAME == "Linux":
        override_dir = Path("/etc/systemd/system/agentautoupdate-run.timer.d")
        override_dir.mkdir(parents=True, exist_ok=True)
        override_path = override_dir / "override.conf"
        override_path.write_text(
            f"[Timer]\nOnCalendar=\nOnCalendar=*-*-* {daily_time}:00\n",
            encoding="utf-8",
        )
        systemctl(["daemon-reload"])
        if enabled:
            systemctl(["enable", "--now", LINUX_TIMER])
            systemctl(["restart", LINUX_TIMER])
        else:
            systemctl(["disable", "--now", LINUX_TIMER])
        return

    if SYSTEM_NAME == "Darwin":
        if enabled:
            _write_launchd_runner(daily_time)
            _launchctl_bootout(LAUNCHD_RUNNER_PLIST)
            _launchctl_bootstrap(LAUNCHD_RUNNER_PLIST)
        else:
            _launchctl_bootout(LAUNCHD_RUNNER_PLIST)
            LAUNCHD_RUNNER_PLIST.unlink(missing_ok=True)
        return

    if SYSTEM_NAME == "Windows":
        if enabled:
            _register_windows_task(
                WINDOWS_RUNNER_TASK,
                APP_DIR / "agent_runner.py",
                ["/SC", "DAILY", "/ST", daily_time],
                ["--run-once"],
            )
        else:
            _run(["schtasks", "/Delete", "/TN", WINDOWS_RUNNER_TASK, "/F"])


def restart_poller():
    if SYSTEM_NAME == "Linux":
        systemctl(["restart", LINUX_SERVICE])
        return

    if SYSTEM_NAME == "Darwin":
        _run(["launchctl", "kickstart", "-k", f"system/{LAUNCHD_POLLER_LABEL}"])
        return

    if SYSTEM_NAME == "Windows":
        _run(["schtasks", "/End", "/TN", WINDOWS_POLLER_TASK])
        _run(["schtasks", "/Run", "/TN", WINDOWS_POLLER_TASK])


def stop_services():
    if SYSTEM_NAME == "Linux":
        systemctl(["stop", LINUX_SERVICE])
        systemctl(["stop", LINUX_TIMER])
        systemctl(["disable", LINUX_SERVICE])
        systemctl(["disable", LINUX_TIMER])
        return

    if SYSTEM_NAME == "Darwin":
        _launchctl_bootout(LAUNCHD_POLLER_PLIST)
        _launchctl_bootout(LAUNCHD_RUNNER_PLIST)
        return

    if SYSTEM_NAME == "Windows":
        _run(["schtasks", "/End", "/TN", WINDOWS_POLLER_TASK])
        _run(["schtasks", "/End", "/TN", WINDOWS_RUNNER_TASK])


def remove_units():
    if SYSTEM_NAME == "Linux":
        paths = [
            "/etc/systemd/system/agentautoupdate.service",
            "/etc/systemd/system/agentautoupdate-run.service",
            "/etc/systemd/system/agentautoupdate-run.timer",
        ]
        for path in paths:
            Path(path).unlink(missing_ok=True)
        override_dir = Path("/etc/systemd/system/agentautoupdate-run.timer.d")
        if override_dir.exists():
            for child in override_dir.iterdir():
                child.unlink(missing_ok=True)
            override_dir.rmdir()
        systemctl(["daemon-reload"])
        Path("/usr/local/bin/agentautoupdate").unlink(missing_ok=True)
        return

    if SYSTEM_NAME == "Darwin":
        LAUNCHD_POLLER_PLIST.unlink(missing_ok=True)
        LAUNCHD_RUNNER_PLIST.unlink(missing_ok=True)
        Path("/usr/local/bin/agentautoupdate").unlink(missing_ok=True)
        return

    if SYSTEM_NAME == "Windows":
        _run(["schtasks", "/Delete", "/TN", WINDOWS_POLLER_TASK, "/F"])
        _run(["schtasks", "/Delete", "/TN", WINDOWS_RUNNER_TASK, "/F"])
