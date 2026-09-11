"""
Antivirus health reporting and on-demand scanning.

The dashboard renders the payloads produced here directly, and the Go agent
(agent/windows/internal/antivirus) returns the same JSON shape for Windows —
so the field names below are a contract, not an implementation detail.

Coverage:
  - Linux : ClamAV (clamscan / clamdscan / freshclam)
  - macOS : ClamAV when installed, otherwise the built-in XProtect, which
            reports signature freshness but exposes no scan interface.

SECURITY MODEL: same rules as lib/packages.py — every command is a fixed
argument list (never a shell string), and the only caller-supplied value, the
scan path, is validated against an allowlist before it is ever passed on.
"""
import os
import platform
import plistlib
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import read_state, write_state
from .logs import log
from .package_manager import detect_package_manager

# Signatures older than this are what "out of date" means for the roll-up.
STALE_SIGNATURE_DAYS = 7

_STATUS_TIMEOUT = 60
_QUICK_SCAN_TIMEOUT = 60 * 60
_FULL_SCAN_TIMEOUT = 6 * 60 * 60

# A scan path is an absolute path with no shell metacharacter and no `..`.
_SCAN_PATH_RE = re.compile(r"^/[A-Za-z0-9._/-]{0,255}$")

# Directories worth a "quick" look: where user-writable content lands.
_QUICK_PATHS = ["/home", "/root", "/tmp", "/var/tmp"]

# Unit names differ between distributions (Debian: clamav-*, Fedora: clamd@scan).
_CLAMD_UNITS = ["clamav-daemon", "clamd@scan", "clamd"]
_CLAMONACC_UNITS = ["clamav-clamonacc", "clamonacc"]

_INSTALL_TIMEOUT = 15 * 60
_SIGNATURE_WAIT_SECONDS = 5 * 60

# The light install: the on-demand scanner and the signature updater, but not
# clamd, which keeps every signature in memory (around 1 GB). Real-time
# scanning stays a separate, deliberate step.
_CLAMAV_PACKAGES = {
    "apt": ["clamav", "clamav-freshclam"],
    "dnf": ["clamav", "clamav-update"],
    "yum": ["clamav", "clamav-update"],
    "pacman": ["clamav"],
    "zypper": ["clamav"],
}
_INSTALL_COMMANDS = {
    # --no-install-recommends keeps apt from pulling clamav-daemon back in.
    "apt": ["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends"],
    "dnf": ["dnf", "install", "-y"],
    "yum": ["yum", "install", "-y"],
    "pacman": ["pacman", "-S", "--noconfirm", "--needed"],
    "zypper": ["zypper", "--non-interactive", "install"],
}

# `clamscan --version` → "ClamAV 1.0.3/27000/Tue Sep 10 08:00:00 2026"
_CLAM_VERSION_RE = re.compile(r"ClamAV\s+([0-9][^/\s]*)(?:/(\d+)/(.+))?")
# A detection line → "/path/to/file: Eicar-Test-Signature FOUND"
_CLAM_FOUND_RE = re.compile(r"^(?P<path>.+): (?P<name>\S+) FOUND\s*$")

_XPROTECT_PLIST = (
    "/Library/Apple/System/Library/CoreServices/XProtect.bundle"
    "/Contents/Info.plist"
)


class AntivirusError(Exception):
    pass


def _run(cmd, timeout, add_sudo=False):
    """Run a fixed argument list without a shell. Never raises on exit code."""
    if add_sudo and os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() != 0:
        cmd = ["sudo", "-n"] + cmd
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        raise AntivirusError(f"Commande introuvable: {cmd[0]}")
    except subprocess.TimeoutExpired:
        raise AntivirusError("Délai dépassé")


def _utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _service_active(unit):
    """True if a systemd unit is active. False on any other init system."""
    if not shutil.which("systemctl"):
        return False
    try:
        code, out, _ = _run(["systemctl", "is-active", unit], 10)
    except AntivirusError:
        return False
    return code == 0 and out.strip() == "active"


def _process_running(name):
    if not shutil.which("pgrep"):
        return False
    try:
        code, _, _ = _run(["pgrep", "-x", name], 10)
    except AntivirusError:
        return False
    return code == 0


def _unit_exists(unit):
    if not shutil.which("systemctl"):
        return False
    try:
        code, _, _ = _run(["systemctl", "cat", unit], 10)
    except AntivirusError:
        return False
    return code == 0


def _first_unit(candidates):
    return next((unit for unit in candidates if _unit_exists(unit)), None)


def _wait_active(unit, timeout):
    """clamd loads every signature before it reports active, which takes a while."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _service_active(unit):
            return True
        time.sleep(2)
    return False


def _unit_status_tail(unit):
    try:
        _, out, err = _run(["systemctl", "status", unit, "--no-pager", "--lines=5"], 10)
    except AntivirusError:
        return ""
    text = (out or err).strip()
    return f"\n{text[-600:]}" if text else ""


def _systemctl_enable_now(unit):
    code, out, err = _run(["systemctl", "enable", "--now", unit], 120, add_sudo=True)
    if code != 0:
        raise AntivirusError(f"Impossible de démarrer {unit} : {(err or out).strip()[:300]}")


def _days_since(moment):
    if not moment:
        return None
    return max(0, int((datetime.now(timezone.utc) - moment).total_seconds() // 86400))


# ---------------------------------------------------------------------------
#  Scan history — the last scan AAUL itself ran on this host
# ---------------------------------------------------------------------------
def _read_scan_history():
    return (read_state() or {}).get("antivirus") or {}


def _record_scan(result):
    """Persist the last scan so a later status call can report it."""
    state = read_state() or {}
    state["antivirus"] = {
        "lastScanAt": result.get("finishedAt"),
        "lastScanType": result.get("scanType"),
        "lastScanThreats": result.get("threatsFound", 0),
        "lastScanFiles": result.get("filesScanned"),
    }
    try:
        write_state(state)
    except Exception as exc:  # a scan result must not be lost over a state write
        log(f"[antivirus] could not persist scan history: {exc}")


# ---------------------------------------------------------------------------
#  ClamAV
# ---------------------------------------------------------------------------
def _clam_binary():
    """Prefer the daemon client: it reuses clamd's loaded signatures."""
    if shutil.which("clamdscan") and _clamd_running():
        return shutil.which("clamdscan"), "clamdscan"
    found = shutil.which("clamscan")
    return (found, "clamscan") if found else (None, None)


def _clamd_running():
    return any(_service_active(unit) for unit in _CLAMD_UNITS) or _process_running("clamd")


def _clam_version_info():
    """Return (product version, signature version, signature date)."""
    binary = shutil.which("clamscan") or shutil.which("clamdscan")
    if not binary:
        return None, None, None
    try:
        _, out, _ = _run([binary, "--version"], _STATUS_TIMEOUT)
    except AntivirusError:
        return None, None, None
    match = _CLAM_VERSION_RE.search(out.strip())
    if not match:
        return None, None, None
    version, signature, raw_date = match.group(1), match.group(2), match.group(3)
    signed_at = None
    if raw_date:
        for fmt in ("%a %b %d %H:%M:%S %Y", "%a %b  %d %H:%M:%S %Y"):
            try:
                signed_at = datetime.strptime(raw_date.strip(), fmt).replace(
                    tzinfo=timezone.utc
                )
                break
            except ValueError:
                continue
    return version, signature, signed_at


def _clam_status():
    version, signature, signed_at = _clam_version_info()
    realtime = any(_service_active(unit) for unit in _CLAMONACC_UNITS) or _process_running("clamonacc")
    freshclam = _service_active("clamav-freshclam") or _process_running("freshclam")
    age = _days_since(signed_at)

    return {
        "product": "ClamAV",
        "version": version,
        "enabled": True,  # an installed clamscan can always be asked to scan
        "realtimeEnabled": realtime,
        # AAUL can only start on-access scanning if clamonacc is installed.
        "realtimeFixable": not realtime and _first_unit(_CLAMONACC_UNITS) is not None,
        "daemonRunning": _clamd_running(),
        "autoUpdateEnabled": freshclam,
        "signatureVersion": signature,
        "signatureUpdatedAt": signed_at.isoformat().replace("+00:00", "Z") if signed_at else None,
        "signatureAgeDays": age,
        "upToDate": age is not None and age <= STALE_SIGNATURE_DAYS,
        "scanSupported": True,
    }


def _validate_scan_path(path):
    path = (path or "").strip()
    if not path:
        return None
    if ".." in path or not _SCAN_PATH_RE.match(path):
        raise AntivirusError("Chemin de scan invalide")
    if not os.path.exists(path):
        raise AntivirusError(f"Chemin introuvable: {path}")
    return path


def _clam_scan(scan_type, path):
    binary, kind = _clam_binary()
    if not binary:
        raise AntivirusError("ClamAV n'est pas installé")

    if path:
        targets = [path]
    elif scan_type == "full":
        targets = ["/"]
    else:
        targets = [p for p in _QUICK_PATHS if os.path.isdir(p)] or ["/home"]

    timeout = _FULL_SCAN_TIMEOUT if scan_type == "full" else _QUICK_SCAN_TIMEOUT
    if kind == "clamdscan":
        # --fdpass hands the descriptors to clamd, so it scans files it could
        # not otherwise open as its own unprivileged user.
        cmd = [binary, "--fdpass", "--multiscan"] + targets
    else:
        cmd = [binary, "--recursive", "--infected"] + targets

    started = _utc_now_iso()
    start_clock = datetime.now(timezone.utc)
    code, out, err = _run(cmd, timeout, add_sudo=True)
    finished = _utc_now_iso()

    threats = []
    for line in (out or "").splitlines():
        match = _CLAM_FOUND_RE.match(line.strip())
        if match:
            threats.append({
                "name": match.group("name"),
                "path": match.group("path"),
                "severity": "detected",
                "detectedAt": finished,
                "action": "reported",
            })

    files_scanned = None
    scanned = re.search(r"Scanned files:\s*(\d+)", out or "")
    if scanned:
        files_scanned = int(scanned.group(1))

    # clamscan: 0 = clean, 1 = infected, 2 = error.
    if code not in (0, 1):
        raise AntivirusError((err or out or "Scan antivirus échoué").strip()[:500])

    return {
        "scanType": scan_type,
        "engine": "ClamAV",
        "targets": targets,
        "startedAt": started,
        "finishedAt": finished,
        "durationSeconds": int((datetime.now(timezone.utc) - start_clock).total_seconds()),
        "filesScanned": files_scanned,
        "threatsFound": len(threats),
        "threats": threats[:100],
        "status": "infected" if threats else "clean",
        "output": (out or "")[-4000:],
    }


# ---------------------------------------------------------------------------
#  macOS XProtect — signature freshness only, no scan interface
# ---------------------------------------------------------------------------
def _xprotect_status():
    plist_path = Path(_XPROTECT_PLIST)
    if not plist_path.exists():
        return None
    try:
        with plist_path.open("rb") as handle:
            data = plistlib.load(handle)
    except Exception:
        return None

    version = data.get("CFBundleShortVersionString") or data.get("CFBundleVersion")
    try:
        signed_at = datetime.fromtimestamp(plist_path.stat().st_mtime, tz=timezone.utc)
    except OSError:
        signed_at = None
    age = _days_since(signed_at)

    return {
        "product": "XProtect (Apple)",
        "version": version,
        "enabled": True,
        "realtimeEnabled": True,
        "realtimeFixable": False,
        "daemonRunning": True,
        "autoUpdateEnabled": True,
        "signatureVersion": version,
        "signatureUpdatedAt": signed_at.isoformat().replace("+00:00", "Z") if signed_at else None,
        "signatureAgeDays": age,
        # XProtect ships definitions with macOS updates, so a longer gap between
        # revisions is normal and does not mean the machine is unprotected.
        "upToDate": age is None or age <= 90,
        "scanSupported": False,
    }


# ---------------------------------------------------------------------------
#  Public API
# ---------------------------------------------------------------------------
def _empty_status(reason):
    return {
        "supported": True,
        "installed": False,
        "product": None,
        "version": None,
        "enabled": False,
        "realtimeEnabled": False,
        "realtimeFixable": False,
        "installAvailable": False,
        "installSource": None,
        "daemonRunning": False,
        "autoUpdateEnabled": False,
        "signatureVersion": None,
        "signatureUpdatedAt": None,
        "signatureAgeDays": None,
        "upToDate": False,
        "scanSupported": False,
        "lastScanAt": None,
        "lastScanType": None,
        "threatsFound": 0,
        "threats": [],
        "otherProducts": [],
        "healthy": False,
        "issues": [reason],
        "checkedAt": _utc_now_iso(),
    }


def _roll_up(status):
    """Turn the raw readings into a health verdict the dashboard can show."""
    issues = []
    if not status["installed"]:
        issues.append("Aucun antivirus détecté")
    else:
        if not status["enabled"]:
            issues.append("Antivirus désactivé")
        if not status["realtimeEnabled"]:
            issues.append("Protection en temps réel inactive")
        if not status["upToDate"]:
            age = status.get("signatureAgeDays")
            issues.append(
                f"Signatures obsolètes ({age} jours)" if age is not None
                else "Âge des signatures inconnu"
            )
        if status.get("installed") and not status.get("autoUpdateEnabled", True):
            issues.append("Mise à jour automatique des signatures inactive")
        if status["threatsFound"]:
            issues.append(f"{status['threatsFound']} menace(s) détectée(s)")
    status["issues"] = issues
    status["healthy"] = not issues
    return status


def get_status():
    """Snapshot of antivirus health for this host."""
    system = platform.system()
    if system == "Windows":
        # The Windows agent is the Go one; this only guards a manual run.
        return _empty_status("Antivirus non pris en charge par l'agent Python sous Windows")

    engine = _clam_status() if shutil.which("clamscan") or shutil.which("clamdscan") else None
    if engine is None and system == "Darwin":
        engine = _xprotect_status()
    if engine is None:
        if system != "Linux":
            return _empty_status("Aucun antivirus détecté")
        status = _empty_status("ClamAV n'est pas installé")
        # Offered, never pushed: the dashboard shows it as an option.
        manager = detect_package_manager()
        if manager in _CLAMAV_PACKAGES and _clamav_available(manager):
            status["installAvailable"] = True
            status["installSource"] = manager
        return status

    history = _read_scan_history()
    status = {
        "supported": True,
        "installed": True,
        "installAvailable": False,
        "installSource": None,
        "lastScanAt": history.get("lastScanAt"),
        "lastScanType": history.get("lastScanType"),
        "threatsFound": int(history.get("lastScanThreats") or 0),
        "threats": [],
        "otherProducts": [],
        "checkedAt": _utc_now_iso(),
        **engine,
    }
    return _roll_up(status)


def run_scan(scan_type=None, path=None):
    """Run a scan now and return its result. Blocking by design."""
    scan_type = (scan_type or "quick").strip().lower()
    if scan_type not in ("quick", "full"):
        raise AntivirusError("Type de scan invalide (quick ou full)")

    target = _validate_scan_path(path)
    if platform.system() == "Windows":
        raise AntivirusError("Scan non pris en charge par l'agent Python sous Windows")
    if not (shutil.which("clamscan") or shutil.which("clamdscan")):
        raise AntivirusError("ClamAV n'est pas installé")

    log(f"[antivirus] scan {scan_type} started")
    result = _clam_scan(scan_type, target)
    _record_scan(result)
    log(f"[antivirus] scan {scan_type} finished: {result['threatsFound']} threat(s)")
    return result


def enable_realtime():
    """Turn on-access (real-time) scanning on and return the resulting status.

    There is deliberately no counterpart: turning protection off has to be
    done on the machine itself.
    """
    if platform.system() != "Linux":
        raise AntivirusError("Activation du temps réel non prise en charge sur ce système")
    if not (shutil.which("clamscan") or shutil.which("clamdscan")):
        raise AntivirusError("ClamAV n'est pas installé")
    onacc = _first_unit(_CLAMONACC_UNITS)
    if not onacc:
        raise AntivirusError("Le scan en temps réel de ClamAV (clamonacc) n'est pas installé")

    # clamonacc hands every file to clamd: without the daemon it exits at once.
    if not _clamd_running():
        daemon = _first_unit(_CLAMD_UNITS)
        if not daemon:
            raise AntivirusError("Le démon ClamAV (clamd) n'est pas installé")
        _systemctl_enable_now(daemon)
        if not _wait_active(daemon, timeout=90):
            raise AntivirusError(f"{daemon} ne démarre pas" + _unit_status_tail(daemon))

    _systemctl_enable_now(onacc)
    if not _wait_active(onacc, timeout=30):
        raise AntivirusError(
            f"{onacc} ne démarre pas — vérifiez OnAccessIncludePath dans clamd.conf"
            + _unit_status_tail(onacc)
        )
    log("[antivirus] real-time protection enabled")
    return get_status()


def _apt_has_candidate(policy_output):
    match = re.search(r"Candidate:\s*(\S+)", policy_output or "")
    return bool(match) and match.group(1) != "(none)"


def _clamav_available(manager):
    """Whether the repositories already configured can provide ClamAV.

    AAUL never adds a repository: on a Red Hat without EPEL, for instance,
    ClamAV is simply not offered.
    """
    query = {
        "apt": ["apt-cache", "policy", "clamav"],
        "dnf": ["dnf", "-q", "list", "--available", "clamav"],
        "yum": ["yum", "-q", "list", "available", "clamav"],
        "pacman": ["pacman", "-Si", "clamav"],
        "zypper": ["zypper", "--non-interactive", "search", "--match-exact", "clamav"],
    }.get(manager)
    if not query:
        return False
    try:
        code, out, _ = _run(query, _STATUS_TIMEOUT)
    except AntivirusError:
        return False
    if manager == "apt":
        return code == 0 and _apt_has_candidate(out)
    return code == 0


def _start_signature_updates():
    """Fetch a first signature set and keep it current.

    clamscan refuses to scan without signatures. Where the distribution ships
    the freshclam service it is enabled (it downloads at once, then keeps the
    set fresh); otherwise freshclam runs once.
    """
    unit = _first_unit(["clamav-freshclam"])
    try:
        if unit:
            if not _service_active(unit):
                _systemctl_enable_now(unit)
        elif shutil.which("freshclam"):
            _run(["freshclam"], _INSTALL_TIMEOUT, add_sudo=True)
    except AntivirusError as exc:
        # The scanner is installed either way; the status will report missing
        # signatures, which is accurate and actionable.
        log(f"[antivirus] signature download not started: {exc}")
        return

    deadline = time.monotonic() + _SIGNATURE_WAIT_SECONDS
    while time.monotonic() < deadline:
        if _clam_version_info()[1]:
            return
        time.sleep(10)


def install_clamav():
    """Install ClamAV's on-demand scanner and signature updater, then report.

    Only ever run because an operator accepted the dashboard's offer. The
    package list is fixed here: the dashboard sends no package name.
    """
    if platform.system() != "Linux":
        raise AntivirusError("L'installation de ClamAV n'est proposée que sous Linux")
    if shutil.which("clamscan") or shutil.which("clamdscan"):
        return get_status()
    manager = detect_package_manager()
    packages = _CLAMAV_PACKAGES.get(manager)
    if not packages:
        raise AntivirusError(f"Gestionnaire de paquets non pris en charge : {manager}")
    if not _clamav_available(manager):
        raise AntivirusError("ClamAV n'est pas disponible dans les dépôts de cette machine")

    log(f"[antivirus] installing ClamAV via {manager}")
    if manager == "apt":
        _run(["apt-get", "update"], _INSTALL_TIMEOUT, add_sudo=True)
    code, out, err = _run(_INSTALL_COMMANDS[manager] + packages, _INSTALL_TIMEOUT, add_sudo=True)
    if code != 0:
        raise AntivirusError("Installation de ClamAV échouée : " + (err or out).strip()[-500:])

    _start_signature_updates()
    log("[antivirus] ClamAV installed")
    return get_status()
