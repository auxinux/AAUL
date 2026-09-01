"""
Lightweight host metrics, collected on every poll.

Why a separate module from `system_info`:
`collect_system_info()` is the *inventory* — CPU model, repositories, disks,
GPU, network interfaces. It is expensive (it shells out to several commands)
and only runs when the dashboard explicitly asks for it (FETCH_INFO).

This module is the *vital signs* — a handful of numbers cheap enough to send
with every heartbeat, so the dashboard can show live CPU / memory / disk usage
per host instead of a stale snapshot from the last manual scan.

Design rules:
- standard library only (the agent ships no psutil);
- never raise: a metric we cannot read is reported as None, never as a crash
  that would break the whole poll;
- bounded cost: the single sleep below is 0.1 s, everything else is a file read.
"""
import os
import platform
import shutil
import time
from pathlib import Path

_SYSTEM = platform.system()

# Pseudo/virtual filesystems: counting them as "disk usage" is meaningless.
_SKIP_FS_TYPES = {
    "proc", "sysfs", "devtmpfs", "devpts", "tmpfs", "securityfs", "cgroup",
    "cgroup2", "pstore", "efivarfs", "bpf", "debugfs", "tracefs", "mqueue",
    "hugetlbfs", "configfs", "fusectl", "squashfs", "overlay", "ramfs",
    "autofs", "binfmt_misc", "nsfs", "fuse.gvfsd-fuse", "fuse.portal",
}


def _safe(fn, default=None):
    """Run a probe, swallowing any failure. Metrics must never break a poll."""
    try:
        return fn()
    except Exception:
        return default


# ---------------------------------------------------------------------------
#  CPU
# ---------------------------------------------------------------------------

def _linux_cpu_percent():
    """Busy percentage over a 0.1 s window, read from /proc/stat."""
    stat_path = Path("/proc/stat")
    if not stat_path.exists():
        return None

    def sample():
        for line in stat_path.read_text().splitlines():
            if line.startswith("cpu "):
                values = [int(x) for x in line.split()[1:]]
                return sum(values), values[3] + (values[4] if len(values) > 4 else 0)
        return None

    first = sample()
    if not first:
        return None
    time.sleep(0.1)
    second = sample()
    if not second:
        return None

    total_diff = second[0] - first[0]
    idle_diff = second[1] - first[1]
    if total_diff <= 0:
        return None
    return round(100.0 * (total_diff - idle_diff) / total_diff, 1)


def _macos_cpu_percent():
    """Parse the aggregate CPU line from `top -l 2` (second sample is live)."""
    import subprocess
    out = subprocess.run(
        ["top", "-l", "2", "-n", "0", "-s", "1"],
        capture_output=True, text=True, timeout=10
    ).stdout
    idle = None
    for line in out.splitlines():
        if line.startswith("CPU usage:") and "idle" in line:
            for chunk in line.split(","):
                if "idle" in chunk:
                    idle = float(chunk.strip().split("%")[0])
    if idle is None:
        return None
    return round(max(0.0, 100.0 - idle), 1)


def _windows_cpu_percent():
    import subprocess
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-CimInstance Win32_Processor | "
         "Measure-Object -Property LoadPercentage -Average).Average"],
        capture_output=True, text=True, timeout=10
    ).stdout.strip()
    return round(float(out), 1) if out else None


def get_cpu_percent():
    if _SYSTEM == "Darwin":
        return _safe(_macos_cpu_percent)
    if _SYSTEM == "Windows":
        return _safe(_windows_cpu_percent)
    return _safe(_linux_cpu_percent)


def get_load_average():
    """1/5/15-minute load average, or None on platforms without it (Windows)."""
    def probe():
        one, five, fifteen = os.getloadavg()
        return {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)}
    return _safe(probe)


# ---------------------------------------------------------------------------
#  Memory
# ---------------------------------------------------------------------------

def get_memory():
    """{totalBytes, usedBytes, availableBytes, percent} — percent is what the UI shows."""
    from .system_info import get_memory_info

    info = _safe(get_memory_info, {}) or {}
    total = int(info.get("totalBytes") or 0)
    used = int(info.get("usedBytes") or 0)
    available = int(info.get("availableBytes") or 0)
    percent = round(100.0 * used / total, 1) if total > 0 else None
    return {
        "totalBytes": total or None,
        "usedBytes": used or None,
        "availableBytes": available or None,
        "percent": percent,
    }


def get_swap():
    """Swap usage on Linux (None elsewhere — not comparable across platforms)."""
    def probe():
        path = Path("/proc/meminfo")
        if not path.exists():
            return None
        values = {}
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith(("SwapTotal:", "SwapFree:")):
                key, value = line.split(":", 1)
                values[key] = int(value.strip().split()[0]) * 1024
        total = values.get("SwapTotal", 0)
        if total <= 0:
            return None
        used = total - values.get("SwapFree", 0)
        return {
            "totalBytes": total,
            "usedBytes": used,
            "percent": round(100.0 * used / total, 1),
        }
    return _safe(probe)


# ---------------------------------------------------------------------------
#  Disk
# ---------------------------------------------------------------------------

def _linux_mount_points():
    mounts = Path("/proc/mounts")
    if not mounts.exists():
        return ["/"]
    seen = []
    for line in mounts.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        mount, fstype = parts[1], parts[2]
        if fstype in _SKIP_FS_TYPES or mount.startswith(("/snap", "/var/lib/docker")):
            continue
        if mount not in seen:
            seen.append(mount)
    return seen or ["/"]


def get_disk():
    """
    Root filesystem usage plus the fullest mounted filesystem.

    `root` is what admins usually watch; `busiest` is what actually pages you
    at 3 a.m. when /var or a data volume fills up while / looks fine.
    """
    def usage(path):
        total, used, free = shutil.disk_usage(path)
        if total <= 0:
            return None
        return {
            "mount": path,
            "totalBytes": total,
            "usedBytes": used,
            "freeBytes": free,
            "percent": round(100.0 * used / total, 1),
        }

    root_path = "C:\\" if _SYSTEM == "Windows" else "/"
    root = _safe(lambda: usage(root_path))

    busiest = root
    if _SYSTEM not in ("Windows", "Darwin"):
        for mount in _linux_mount_points():
            entry = _safe(lambda m=mount: usage(m))
            if entry and (busiest is None or entry["percent"] > busiest["percent"]):
                busiest = entry

    return {"root": root, "busiest": busiest}


# ---------------------------------------------------------------------------
#  Misc
# ---------------------------------------------------------------------------

def get_process_count():
    def probe():
        if _SYSTEM in ("Windows", "Darwin"):
            return None
        return sum(1 for entry in os.listdir("/proc") if entry.isdigit())
    return _safe(probe)


def get_logged_in_users():
    def probe():
        import subprocess
        if _SYSTEM == "Windows":
            return None
        out = subprocess.run(["who"], capture_output=True, text=True, timeout=5).stdout
        return len({line.split()[0] for line in out.splitlines() if line.strip()})
    return _safe(probe)


def collect_metrics():
    """
    The full vital-signs payload sent with every poll.

    Kept deliberately flat and small (< 1 KB) — it travels on every heartbeat,
    which for a large fleet at a 15 s interval adds up fast.
    """
    from .util import utc_now_iso

    return {
        "collectedAt": utc_now_iso(),
        "cpuPercent": get_cpu_percent(),
        "loadAverage": get_load_average(),
        "cpuCount": os.cpu_count(),
        "memory": get_memory(),
        "swap": get_swap(),
        "disk": get_disk(),
        "processCount": get_process_count(),
        "loggedInUsers": get_logged_in_users(),
    }
