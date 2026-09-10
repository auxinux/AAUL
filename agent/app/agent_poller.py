"""Main polling loop that talks to the dashboard.

Runs as a service: polls at a configurable interval, executes whatever
command comes back (update, schedule change, uninstall, ...), reports the
result, and optionally keeps the local web interface running.

    python agent_poller.py          # run continuously
    python agent_poller.py --once   # single poll, useful for testing
"""

import argparse
import os
import threading
import time

from lib.api import api_post
from lib.config import load_config, read_state, save_config, get_agent_version
from lib.uninstall import uninstall_agent
from lib.util import append_log, get_hostname, get_primary_ip, utc_now_iso
from lib.system_info import collect_system_info, get_reboot_required, get_uptime_seconds
from lib.systemd import set_schedule, restart_poller
from lib.logs import list_logs, read_log, apply_retention, get_log_stats
from lib.metrics import collect_metrics
from lib.updater import update_agent, UpdateError
from lib.local_web import get_local_web_manager, start_local_server, stop_local_server, is_server_running
from agent_runner import run_update


# The dashboard refuses anything shorter, but an old config.json written
# before that rule (or edited by hand) must not be able to hammer the server.
MIN_POLL_INTERVAL_SECONDS = 5

_local_web_manager = None


def get_local_web():
    """Get the local web manager singleton."""
    global _local_web_manager
    if _local_web_manager is None:
        _local_web_manager = get_local_web_manager()
    return _local_web_manager


def build_payload(config):
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
        # Vital signs, cheap enough to ride along on every heartbeat so the
        # dashboard shows live usage instead of the last manual FETCH_INFO.
        "metrics": _safe_metrics(),
        "logStats": _safe_log_stats()
    }


def _safe_metrics():
    """Metrics must never break a poll: a failed probe degrades to None."""
    try:
        return collect_metrics()
    except Exception as exc:
        append_log(f"metrics collection failed: {exc}")
        return None


def _safe_log_stats():
    try:
        return get_log_stats()
    except Exception:
        return None


def handle_command(config, command):
    cmd_type = command.get("type")
    result_payload = {}
    error_message = None
    status = "DONE"
    restart = False
    exit_after = False

    try:
        if cmd_type == "RUN_NOW":
            result = run_update()
            result_payload = {
                "lastStatus": result["status"],
                "lastExitCode": result["exit_code"],
                "lastDurationSeconds": result["duration"]
            }
            if result["status"] != "OK":
                status = "ERROR"
                error_message = result.get("message")
        elif cmd_type == "SET_SCHEDULE":
            payload = command.get("payload") or {}
            enabled = bool(payload.get("enabled"))
            daily_time = payload.get("dailyTime") or "03:00"
            config["schedule"] = {"enabled": enabled, "dailyTime": daily_time}
            save_config(config)
            set_schedule(enabled, daily_time)
            result_payload = {"schedule": config["schedule"]}
        elif cmd_type == "UPDATE_AGENT":
            new_version = update_agent(config)
            result_payload = {"version": new_version}
            restart = True
        elif cmd_type == "SET_POLL_INTERVAL":
            payload = command.get("payload") or {}
            poll_value = int(payload.get("pollIntervalSeconds") or 0)
            if poll_value < MIN_POLL_INTERVAL_SECONDS:
                raise ValueError(
                    f"Invalid poll interval (minimum {MIN_POLL_INTERVAL_SECONDS}s)"
                )
            config["pollIntervalSeconds"] = poll_value
            save_config(config)
            result_payload = {"pollIntervalSeconds": poll_value}
            restart = True
        elif cmd_type == "UNINSTALL":
            uninstall_agent(stop_running=False)
            result_payload = {"uninstalled": True}
            exit_after = True
        elif cmd_type == "LIST_LOGS":
            result_payload = {"logs": list_logs(), "stats": _safe_log_stats()}
        elif cmd_type == "PRUNE_LOGS":
            payload = command.get("payload") or {}
            result_payload = apply_retention(
                payload.get("retentionDays"), payload.get("maxTotalMb")
            )
            result_payload["stats"] = _safe_log_stats()
        elif cmd_type == "FETCH_LOG":
            payload = command.get("payload") or {}
            log_name = payload.get("logName")
            if not log_name:
                raise ValueError("Missing logName")
            result_payload = read_log(log_name)
        elif cmd_type == "FETCH_INFO":
            result_payload = collect_system_info()
        elif cmd_type == "PACKAGES_LIST":
            from lib.packages import list_installed
            result_payload = list_installed()
        elif cmd_type == "PACKAGE_SEARCH":
            from lib.packages import search
            payload = command.get("payload") or {}
            result_payload = search(payload.get("query"))
        elif cmd_type == "PACKAGE_INSTALL":
            from lib.packages import install
            payload = command.get("payload") or {}
            result_payload = install(payload.get("name"))
            if not result_payload.get("success"):
                status = "ERROR"
                error_message = "Installation échouée"
        elif cmd_type == "PACKAGE_REMOVE":
            from lib.packages import remove
            payload = command.get("payload") or {}
            result_payload = remove(payload.get("name"))
            if not result_payload.get("success"):
                status = "ERROR"
                error_message = "Désinstallation échouée"
        elif cmd_type == "CHECK_UPDATES":
            from lib.packages import check_updates
            result_payload = check_updates()
        elif cmd_type == "UPDATE_PACKAGES":
            from lib.packages import update_packages
            payload = command.get("payload") or {}
            result_payload = update_packages(payload.get("names"))
            if not result_payload.get("success"):
                status = "ERROR"
                error_message = "Mise à jour échouée"
        else:
            status = "ERROR"
            error_message = f"Unknown command {cmd_type}"
    except UpdateError as exc:
        status = "ERROR"
        error_message = str(exc)
    except Exception as exc:
        status = "ERROR"
        error_message = str(exc)

    return status, result_payload, error_message, restart, exit_after


def send_command_result(config, command_id, status, result, error_message):
    payload = {
        "agentId": config.get("agentId"),
        "commandId": command_id,
        "status": status,
        "result": result,
        "errorMessage": error_message
    }
    api_post(config, "/api/agent/command-result", payload)


def apply_local_web_config(response):
    """Apply the localWeb config block from a poll response, if present."""
    local_web_config = response.get("localWeb")
    if local_web_config is None:
        return

    try:
        manager = get_local_web()
        manager.apply_config({"localWeb": local_web_config})
    except Exception as exc:
        append_log(f"Failed to apply local web config: {exc}")


# Retention is re-applied at most once an hour: it walks the log directory,
# which is cheap but pointless to redo at every 15-second poll.
_RETENTION_INTERVAL_SECONDS = 3600
_last_retention_at = 0.0


def apply_logs_config(response):
    """Apply the `logs` retention block from a poll response, if present."""
    global _last_retention_at
    logs_config = response.get("logs")
    if not isinstance(logs_config, dict):
        return
    now = time.time()
    if now - _last_retention_at < _RETENTION_INTERVAL_SECONDS:
        return
    _last_retention_at = now
    try:
        apply_retention(
            logs_config.get("retentionDays"), logs_config.get("maxTotalMb")
        )
    except Exception as exc:
        append_log(f"Failed to apply log retention: {exc}")


# Only one command runs at a time. The heartbeat (poll loop) keeps running while
# a command executes in this worker thread, so the agent stays "online" during
# long operations like a system update instead of looking dead.
_command_lock = threading.Lock()


def _run_command_worker(config, command):
    """Execute a command in a background thread; releases the lock when done."""
    try:
        status, result, error_message, restart, exit_after = handle_command(config, command)
        try:
            send_command_result(config, command.get("id"), status, result, error_message)
        except Exception as exc:
            append_log(f"send_command_result error: {exc}")
        if restart:
            restart_poller()
            os._exit(0)   # kill the whole process (not just this thread)
        if exit_after:
            os._exit(0)
    except Exception as exc:
        append_log(f"command worker error: {exc}")
    finally:
        try:
            _command_lock.release()
        except RuntimeError:
            pass


def poll_once(async_commands=False):
    config = load_config()
    busy = _command_lock.locked()

    payload = build_payload(config)
    # When a command is already running, ask the dashboard not to hand out a new
    # one — this poll is purely a heartbeat to refresh last_seen.
    extra_headers = {"X-Skip-Command": "true"} if busy else None
    response = api_post(config, "/api/agent/poll", payload, extra_headers=extra_headers)

    state = read_state()
    state["lastPoll"] = utc_now_iso()
    from lib.config import write_state
    write_state(state)

    apply_local_web_config(response)
    apply_logs_config(response)

    latest_agent_version = response.get("latestAgentVersion")
    if latest_agent_version:
        current_version = get_agent_version()
        if latest_agent_version != current_version:
            append_log(
                f"Agent update available: current={current_version} latest={latest_agent_version} "
                f"(trigger UPDATE_AGENT from dashboard to apply)"
            )

    command = response.get("command")
    if not command:
        return

    if async_commands:
        # Dispatch to the worker only if no command is currently running.
        if _command_lock.acquire(blocking=False):
            threading.Thread(
                target=_run_command_worker, args=(config, command), daemon=True
            ).start()
        else:
            append_log("Command received while busy; will pick up after current one finishes")
        return

    # Synchronous path (used by --once for testing/debugging).
    status, result, error_message, restart, exit_after = handle_command(config, command)
    send_command_result(config, command.get("id"), status, result, error_message)
    if restart:
        restart_poller()
        raise SystemExit(0)
    if exit_after:
        raise SystemExit(0)


def main():
    """Entry point: either a single poll (--once) or the continuous loop."""
    parser = argparse.ArgumentParser(description="Agent Auto Update poller")
    parser.add_argument("--once", action="store_true", help="Send a single poll")
    args = parser.parse_args()

    if args.once:
        try:
            poll_once()
        except Exception as exc:
            append_log(f"poll_once error: {exc}")
        return

    config = load_config()
    interval = max(int(config.get("pollIntervalSeconds", 60)), MIN_POLL_INTERVAL_SECONDS)

    try:
        manager = get_local_web()
        append_log(f"Local web manager initialized: running={manager.is_running()}")
    except Exception as exc:
        append_log(f"Failed to initialize local web manager: {exc}")

    try:
        while True:
            try:
                # Heartbeat: keeps last_seen fresh even while a command runs in
                # the background worker thread.
                poll_once(async_commands=True)
            except Exception as exc:
                append_log(f"poll error: {exc}")
            time.sleep(interval)
    finally:
        try:
            manager = get_local_web()
            if manager.is_running():
                manager.stop()
        except:
            pass


if __name__ == "__main__":
    main()
