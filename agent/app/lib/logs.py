"""
Agent-side log files: listing, reading, and retention.

Retention exists because the agent writes one log file per day and nothing
ever removed them: a machine polling every 15 s for two years accumulates 700+
files. The dashboard pushes a retention policy on every poll (see
`apply_retention`), so an operator sets it once, centrally, and every host in
the fleet enforces it locally without a command round-trip.
"""
import datetime
import re
from pathlib import Path

from .config import LOG_DIR
from .util import append_log

# Only files the agent itself produced are ever eligible for deletion.
# A stray file dropped in the log directory by someone else is left alone.
_AGENT_LOG_RE = re.compile(r"^agent-\d{4}-\d{2}-\d{2}\.log$")

# Safety rails on whatever the dashboard sends us: never let a bad setting
# wipe today's log or let retention effectively disable itself.
_MIN_RETENTION_DAYS = 1
_MAX_RETENTION_DAYS = 3650
_MIN_TOTAL_MB = 1
_MAX_TOTAL_MB = 100000


def _to_iso(ts):
    return datetime.datetime.fromtimestamp(ts).astimezone().isoformat()


def list_logs():
    if not LOG_DIR.exists():
        return []
    logs = []
    for path in sorted(LOG_DIR.glob("*.log")):
        try:
            stat = path.stat()
        except OSError:
            continue
        logs.append(
            {
                "name": path.name,
                "sizeBytes": stat.st_size,
                "modifiedAt": _to_iso(stat.st_mtime)
            }
        )
    return logs


def read_log(name, max_bytes=200000):
    safe_name = Path(name).name
    path = LOG_DIR / safe_name
    if not path.exists():
        raise FileNotFoundError(safe_name)

    size = path.stat().st_size
    truncated = False
    if size > max_bytes:
        truncated = True
        with path.open("rb") as handle:
            handle.seek(size - max_bytes)
            content = handle.read().decode("utf-8", errors="replace")
    else:
        content = path.read_text(encoding="utf-8", errors="replace")

    return {
        "name": safe_name,
        "sizeBytes": size,
        "truncated": truncated,
        "content": content
    }


def log(message):
    """Write a log message to the agent log file."""
    append_log(message)


# ---------------------------------------------------------------------------
#  Retention
# ---------------------------------------------------------------------------

def _agent_log_files():
    """Agent-produced log files, newest first, with their stat info."""
    if not LOG_DIR.exists():
        return []
    entries = []
    for path in LOG_DIR.glob("*.log"):
        if not _AGENT_LOG_RE.match(path.name):
            continue
        try:
            entries.append((path, path.stat()))
        except OSError:
            continue
    entries.sort(key=lambda item: item[1].st_mtime, reverse=True)
    return entries


def get_log_stats():
    """Summary reported to the dashboard so it can show disk usage per host."""
    entries = _agent_log_files()
    total = sum(stat.st_size for _, stat in entries)
    return {
        "fileCount": len(entries),
        "totalBytes": total,
        "oldest": _to_iso(entries[-1][1].st_mtime) if entries else None,
        "newest": _to_iso(entries[0][1].st_mtime) if entries else None,
    }


def _clamp(value, low, high):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return max(low, min(high, number))


def apply_retention(retention_days=None, max_total_mb=None):
    """
    Enforce the retention policy and return what was removed.

    Two independent limits, applied in this order:
      1. age  — delete logs older than `retention_days`;
      2. size — while the remaining logs exceed `max_total_mb`, delete the
         oldest one.

    The current day's log is never deleted, whatever the settings say: losing
    the log you are actively writing to would hide the very incident you are
    trying to diagnose.
    """
    days = _clamp(retention_days, _MIN_RETENTION_DAYS, _MAX_RETENTION_DAYS)
    max_mb = _clamp(max_total_mb, _MIN_TOTAL_MB, _MAX_TOTAL_MB)
    if days is None and max_mb is None:
        return {"applied": False, "removed": [], "freedBytes": 0}

    today_name = f"agent-{datetime.date.today().isoformat()}.log"
    entries = [item for item in _agent_log_files() if item[0].name != today_name]

    removed = []
    freed = 0

    def drop(path, stat):
        nonlocal freed
        try:
            path.unlink()
        except OSError:
            return False
        removed.append(path.name)
        freed += stat.st_size
        return True

    if days is not None:
        cutoff = (
            datetime.datetime.now().astimezone() - datetime.timedelta(days=days)
        ).timestamp()
        survivors = []
        for path, stat in entries:
            if stat.st_mtime < cutoff:
                drop(path, stat)
            else:
                survivors.append((path, stat))
        entries = survivors

    if max_mb is not None:
        budget = max_mb * 1024 * 1024
        # Today's log counts against the budget even though it is never deleted.
        total = sum(stat.st_size for _, stat in entries)
        try:
            total += (LOG_DIR / today_name).stat().st_size
        except OSError:
            pass
        # entries is newest-first; pop from the end to remove the oldest first.
        while total > budget and entries:
            path, stat = entries.pop()
            if drop(path, stat):
                total -= stat.st_size

    if removed:
        append_log(
            f"[logs] retention applied: {len(removed)} file(s) removed, "
            f"{freed} bytes freed (days={days}, maxMb={max_mb})"
        )

    return {
        "applied": True,
        "retentionDays": days,
        "maxTotalMb": max_mb,
        "removed": removed,
        "freedBytes": freed,
    }
