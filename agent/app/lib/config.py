import json
import os
import platform
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[1]
SYSTEM_NAME = platform.system()


def _default_runtime_dir():
    if SYSTEM_NAME == "Windows":
        return Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "AgentAutoUpdate"
    if SYSTEM_NAME == "Darwin":
        return Path("/Library/Application Support/AgentAutoUpdate")
    return Path("/opt/agentautoupdate")


RUNTIME_DIR = Path(os.environ.get("AAUL_RUNTIME_DIR", _default_runtime_dir()))
CONFIG_PATH = Path(os.environ.get("AAUL_CONFIG_PATH", RUNTIME_DIR / "config.json"))
STATE_PATH = Path(os.environ.get("AAUL_STATE_PATH", RUNTIME_DIR / "state.json"))
LOG_DIR = Path(os.environ.get("AAUL_LOG_DIR", RUNTIME_DIR / "logs"))
LOCK_PATH = Path(os.environ.get("AAUL_LOCK_PATH", RUNTIME_DIR / "run.lock"))
VENV_DIR = Path(os.environ.get("AAUL_VENV_DIR", RUNTIME_DIR / "venv"))
SECURITY_CONFIG_PATH = Path(os.environ.get("AAUL_SECURITY_CONFIG_PATH", RUNTIME_DIR / "security.json"))
LOCAL_WEB_STATE_PATH = Path(
    os.environ.get("AAUL_LOCAL_WEB_STATE_PATH", RUNTIME_DIR / "local_web_state.json")
)
VERSION_PATH = APP_DIR / "VERSION"


def ensure_runtime_dirs():
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json_atomic(path, payload):
    ensure_runtime_dirs()
    tmp_path = path.with_suffix(f"{path.suffix}.tmp")
    tmp_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp_path.replace(path)


def load_config():
    if not CONFIG_PATH.exists():
        raise FileNotFoundError(f"Missing config: {CONFIG_PATH}")
    data = _read_json(CONFIG_PATH)
    schedule = data.get("schedule") or {}
    data["schedule"] = {
        "enabled": bool(schedule.get("enabled", False)),
        "dailyTime": schedule.get("dailyTime", "03:00"),
    }
    return data


def save_config(data):
    schedule = data.get("schedule") or {}
    payload = {
        **data,
        "schedule": {
            "enabled": bool(schedule.get("enabled", False)),
            "dailyTime": schedule.get("dailyTime", "03:00"),
        },
    }
    _write_json_atomic(CONFIG_PATH, payload)


def read_state():
    if not STATE_PATH.exists():
        return {}
    try:
        return _read_json(STATE_PATH)
    except json.JSONDecodeError:
        return {}


def write_state(state):
    _write_json_atomic(STATE_PATH, state)


def get_agent_version():
    if VERSION_PATH.exists():
        return VERSION_PATH.read_text(encoding="utf-8").strip()
    return "0.0.0"
