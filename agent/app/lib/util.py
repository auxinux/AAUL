import datetime
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

from .config import LOG_DIR, LOCK_PATH, ensure_runtime_dirs

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None


def ensure_log_dir():
    ensure_runtime_dirs()


def get_log_path():
    ensure_log_dir()
    date_str = datetime.date.today().isoformat()
    return LOG_DIR / f"agent-{date_str}.log"


def utc_now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def local_now_iso():
    return datetime.datetime.now().astimezone().isoformat()


def local_now_human():
    return datetime.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S")


def append_log(message, log_path=None):
    path = log_path or get_log_path()
    timestamp = local_now_iso()
    with path.open("a", encoding="utf-8") as handle:
        handle.write(f"[{timestamp}] {message}\n")


def get_hostname():
    return socket.gethostname()


def get_primary_ip():
    # Most reliable cross-platform method: UDP socket trick (no packet actually sent)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    try:
        output = subprocess.check_output(
            ["ip", "route", "get", "1.1.1.1"], text=True
        )
        match = re.search(r"\bsrc\s+(\S+)", output)
        if match:
            return match.group(1)
    except Exception:
        pass

    try:
        output = subprocess.check_output(["hostname", "-I"], text=True)
        for ip in output.split():
            if not ip.startswith("127."):
                return ip
    except Exception:
        pass

    try:
        ip = socket.gethostbyname(socket.gethostname())
        if ip and not ip.startswith("127."):
            return ip
    except Exception:
        pass

    return None


def acquire_lock():
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(LOCK_PATH), os.O_CREAT | os.O_RDWR)
    if fcntl is None:
        return fd
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except OSError:
        os.close(fd)
        return None


def release_lock(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def run_command(command, env=None, log_path=None, stream_output=False):
    start = time.time()
    if log_path is None:
        raise ValueError("log_path is required")
    with open(log_path, "a", encoding="utf-8") as log_file:
        header = f"\n$ {' '.join(command)}\n"
        log_file.write(header)
        log_file.flush()
        if stream_output:
            sys.stdout.write(header)
            sys.stdout.flush()
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=env,
                text=True
            )
            assert process.stdout is not None
            for line in process.stdout:
                log_file.write(line)
                log_file.flush()
                sys.stdout.write(line)
                sys.stdout.flush()
            returncode = process.wait()
        else:
            result = subprocess.run(command, stdout=log_file, stderr=log_file, env=env)
            returncode = result.returncode
    duration = time.time() - start
    return returncode, duration
