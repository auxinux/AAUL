import datetime
from pathlib import Path

from .config import LOG_DIR
from .util import append_log


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
