import argparse
import os
import time

from lib.config import read_state, write_state
from lib.util import (
    acquire_lock,
    release_lock,
    get_log_path,
    run_command,
    utc_now_iso,
    local_now_human
)
from lib.package_manager import get_update_commands, detect_package_manager


def run_update(stream_output=False):
    lock_fd = acquire_lock()
    if lock_fd is None:
        return {
            "status": "ERROR",
            "exit_code": 1,
            "duration": 0,
            "message": "Update already running"
        }

    start_time = time.time()
    log_path = get_log_path()
    status = "OK"
    exit_code = 0
    error_message = None
    start_human = local_now_human()

    with log_path.open("a", encoding="utf-8") as log_file:
        log_file.write(f"\nSTART: {start_human}\n")

    env = os.environ.copy()
    manager = detect_package_manager()
    if manager == "apt":
        env["DEBIAN_FRONTEND"] = "noninteractive"

    try:
        commands = get_update_commands()
        if not commands:
            status = "ERROR"
            exit_code = 2
            error_message = "Unsupported package manager"
        else:
            for command in commands:
                code, _ = run_command(
                    command,
                    env=env,
                    log_path=log_path,
                    stream_output=stream_output
                )
                if code != 0:
                    status = "ERROR"
                    exit_code = code
                    break
    finally:
        duration = int(time.time() - start_time)
        now = utc_now_iso()
        end_human = local_now_human()
        with log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(
                f"END: {end_human} | status={status} | exit={exit_code} | duration={duration}s\n"
            )
        state = read_state()
        state.update(
            {
                "lastRunAt": now,
                "lastStatus": status,
                "lastExitCode": exit_code,
                "lastDurationSeconds": duration
            }
        )
        # Update lastUpdate timestamp if successful
        if status == "OK":
            state["lastUpdate"] = now
        write_state(state)
        release_lock(lock_fd)

    return {
        "status": status,
        "exit_code": exit_code,
        "duration": duration,
        "log_path": str(log_path),
        "message": error_message
    }


def main():
    parser = argparse.ArgumentParser(description="Run APT update cycle")
    parser.add_argument("--run-once", action="store_true", help="Run update once")
    args = parser.parse_args()
    if args.run_once:
        result = run_update()
        if result["status"] == "ERROR":
            raise SystemExit(result["exit_code"])


if __name__ == "__main__":
    main()
