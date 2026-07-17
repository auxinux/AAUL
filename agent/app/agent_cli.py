"""Local command-line interface for a managed AAUL agent.

The dashboard is the normal control plane, but operators still need a local
CLI for break-glass operations such as:

- running updates immediately
- changing the dashboard URL
- inspecting local state
- uninstalling the agent
"""
import argparse
import ctypes
import json
import os
import platform
import sys
from urllib.parse import urlparse

from agent_runner import run_update
from lib.api import api_post
from lib.config import LOG_DIR, load_config, read_state, get_agent_version, save_config
from lib.system_info import get_reboot_required, get_uptime_seconds
from lib.systemd import restart_poller
from lib.uninstall import uninstall_agent
from lib.updater import update_agent
from lib.util import get_hostname, get_primary_ip, utc_now_iso


def build_payload(config):
    """Build the lightweight heartbeat payload used for explicit check-ins."""
    state = read_state()
    return {
        "agentId": config.get("agentId"),
        "displayName": config.get("displayName"),
        "hostname": get_hostname(),
        "ip": get_primary_ip(),
        "agentVersion": get_agent_version(),
        "lastSeenAt": utc_now_iso(),
        "lastRunAt": state.get("lastRunAt"),
        "lastStatus": state.get("lastStatus"),
        "lastExitCode": state.get("lastExitCode"),
        "lastDurationSeconds": state.get("lastDurationSeconds"),
        "schedule": config.get("schedule"),
        "uptimeSeconds": get_uptime_seconds(),
        "rebootRequired": get_reboot_required(),
    }


def normalize_dashboard_url(current_url, new_addr):
    """Accept a host, host:port, or full URL and normalize it to a dashboard base URL."""
    cleaned = (new_addr or "").strip()
    if not cleaned:
        raise ValueError("Missing address")
    if "://" in cleaned:
        return cleaned.rstrip("/")

    scheme = "http"
    port = ""
    try:
        parsed = urlparse(current_url or "")
        if parsed.scheme:
            scheme = parsed.scheme
        if parsed.port:
            port = f":{parsed.port}"
    except Exception:
        pass

    if ":" in cleaned:
        return f"{scheme}://{cleaned}".rstrip("/")
    if port:
        return f"{scheme}://{cleaned}{port}".rstrip("/")
    return f"{scheme}://{cleaned}".rstrip("/")


def send_check_in(config):
    """Best-effort heartbeat used after local operations."""
    try:
        api_post(
            config,
            "/api/agent/poll",
            build_payload(config),
            extra_headers={"X-Skip-Command": "true"},
        )
    except Exception:
        pass


def is_admin():
    """Return True when the current process has the privileges required for mutating commands."""
    if os.name == "nt":
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    if hasattr(os, "geteuid"):
        return os.geteuid() == 0
    return False


def require_admin(command_name):
    """Abort with a human-readable message when a command needs elevation."""
    if is_admin():
        return
    if os.name == "nt":
        print(f"The '{command_name}' command requires an elevated Administrator shell.")
    else:
        print(f"The '{command_name}' command requires root privileges. Re-run with sudo.")
    raise SystemExit(1)


def confirm(prompt, assume_yes=False):
    """Simple yes/no confirmation for local destructive commands."""
    if assume_yes or not sys.stdin.isatty():
        return assume_yes
    answer = input(f"{prompt} [y/N]: ").strip().lower()
    return answer in {"y", "yes"}


def show_latest_log(tail_lines=None):
    """Print the newest agent log file, optionally truncated to the last N lines."""
    if not LOG_DIR.exists():
        print("No logs found.")
        return
    files = sorted(LOG_DIR.glob("*.log"), key=lambda path: path.stat().st_mtime)
    if not files:
        print("No logs found.")
        return
    latest = files[-1]
    content = latest.read_text(encoding="utf-8", errors="ignore").splitlines()
    if tail_lines:
        content = content[-tail_lines:]
    print("\n".join(content))


def print_status():
    """Print local agent state as JSON for scripts and support workflows."""
    config = load_config()
    state = read_state()
    payload = {
        "agentId": config.get("agentId"),
        "displayName": config.get("displayName"),
        "dashboardUrl": config.get("dashboardUrl"),
        "version": get_agent_version(),
        "schedule": config.get("schedule"),
        "pollIntervalSeconds": config.get("pollIntervalSeconds"),
        "lastRunAt": state.get("lastRunAt"),
        "lastStatus": state.get("lastStatus"),
        "lastExitCode": state.get("lastExitCode"),
        "lastDurationSeconds": state.get("lastDurationSeconds"),
        "uptimeSeconds": get_uptime_seconds(),
        "rebootRequired": get_reboot_required(),
    }
    print(json.dumps(payload, indent=2))


def apply_dashboard_url_change(address, assume_yes=False):
    """Persist a new dashboard URL after local operator confirmation."""
    require_admin("config set-dashboard")
    config = load_config()
    current = config.get("dashboardUrl") or ""
    try:
        next_url = normalize_dashboard_url(current, address)
    except ValueError as exc:
        print(str(exc))
        raise SystemExit(1)
    if not confirm(f"Change dashboard URL from {current} to {next_url}?", assume_yes):
        print("Change cancelled.")
        return
    config["dashboardUrl"] = next_url
    save_config(config)
    print(f"Dashboard URL updated to {next_url}.")


def execute_update():
    """Run OS package updates immediately on the local machine."""
    require_admin("update")
    config = load_config()
    print("Running update. Output will stream below.\n")
    result = run_update(stream_output=True)
    send_check_in(config)
    if result["status"] != "OK":
        print(result.get("message", "Update failed"))
        raise SystemExit(result["exit_code"])
    print("Update completed.")


def execute_agent_update():
    """Download and apply the latest agent bundle from the dashboard."""
    require_admin("update-agent")
    config = load_config()
    print("Updating agent. Output will stream below.\n")
    new_version = update_agent(config, verbose=True)
    send_check_in(config)
    restart_poller()
    print(f"Updated agent to {new_version}.")


def execute_uninstall(assume_yes=False):
    """Remove the local agent installation."""
    require_admin("uninstall")
    if not confirm("Uninstall agent and remove files?", assume_yes):
        print("Uninstall cancelled.")
        return
    config = load_config()
    send_check_in(config)
    uninstall_agent(stop_running=True)
    print("Agent uninstalled.")


def execute_check_in():
    """Send a one-off poll without asking the dashboard for work."""
    config = load_config()
    send_check_in(config)
    print("Check-in sent.")


def build_parser():
    """Build the argparse tree, including legacy compatibility flags."""
    parser = argparse.ArgumentParser(description="Agent Auto Update CLI")
    parser.add_argument("-version", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--version", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("-config", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("-newaddr", help=argparse.SUPPRESS)
    parser.add_argument(
        "-action",
        choices=["update", "updateagent", "showlog", "uninstall"],
        help=argparse.SUPPRESS,
    )
    parser.add_argument("--yes", action="store_true", help="Skip confirmation prompts")

    subparsers = parser.add_subparsers(dest="command")

    subparsers.add_parser("version", help="Show the installed agent version")
    subparsers.add_parser("status", help="Print the current local agent status as JSON")
    subparsers.add_parser("check-in", help="Send an immediate dashboard heartbeat without running commands")

    logs_parser = subparsers.add_parser("logs", help="Print the latest agent log")
    logs_parser.add_argument("--tail", type=int, default=0, help="Only print the last N lines")

    update_parser = subparsers.add_parser("update", help="Run operating system updates now")
    update_parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)

    agent_update_parser = subparsers.add_parser(
        "update-agent", help="Download and apply the latest agent bundle from the dashboard"
    )
    agent_update_parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)

    uninstall_parser = subparsers.add_parser("uninstall", help="Remove the local agent installation")
    uninstall_parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)

    config_parser = subparsers.add_parser("config", help="Inspect or change local agent configuration")
    config_subparsers = config_parser.add_subparsers(dest="config_command")
    config_subparsers.add_parser("show", help="Print the local configuration file")
    dashboard_parser = config_subparsers.add_parser(
        "set-dashboard", help="Update the dashboard URL or host"
    )
    dashboard_parser.add_argument("address", help="Host, host:port or full http/https URL")

    return parser


def translate_legacy_args(args):
    """Map the historic single-flag CLI to the modern subcommand layout."""
    if args.command:
        return args

    if args.version:
        args.command = "version"
        return args

    if args.config:
        args.command = "config"
        args.config_command = "set-dashboard"
        args.address = args.newaddr
        return args

    if args.action == "update":
        args.command = "update"
    elif args.action == "updateagent":
        args.command = "update-agent"
    elif args.action == "showlog":
        args.command = "logs"
        args.tail = 0
    elif args.action == "uninstall":
        args.command = "uninstall"

    return args


def main():
    parser = build_parser()
    args = parser.parse_args()
    args = translate_legacy_args(args)

    if args.command == "version":
        print(get_agent_version())
        return

    if args.command == "status":
        print_status()
        return

    if args.command == "logs":
        show_latest_log(getattr(args, "tail", 0) or None)
        return

    if args.command == "check-in":
        execute_check_in()
        return

    if args.command == "update":
        execute_update()
        return

    if args.command == "update-agent":
        execute_agent_update()
        return

    if args.command == "uninstall":
        execute_uninstall(args.yes)
        return

    if args.command == "config":
        if args.config_command == "show":
            print(json.dumps(load_config(), indent=2))
            return
        if args.config_command == "set-dashboard":
            if not getattr(args, "address", None):
                print("Missing dashboard address.")
                raise SystemExit(1)
            apply_dashboard_url_change(args.address, args.yes)
            return
        parser.error("Missing config subcommand")

    parser.print_help()
    raise SystemExit(1)


if __name__ == "__main__":
    main()
