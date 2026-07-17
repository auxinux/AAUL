"""Host inventory collection for the dashboard.

The dashboard wants a compact snapshot of the machine:

- OS details
- uptime and reboot requirements
- CPU, memory, disks, IPs, repositories, and package counts

This module keeps the platform-specific probes together so the rest of the
agent can treat system information as structured data.
"""
import os
import platform
import re
import shutil
import subprocess
import time
import json
from pathlib import Path

try:
    import ctypes
except ImportError:  # pragma: no cover
    ctypes = None

try:
    import winreg
except ImportError:  # pragma: no cover
    winreg = None

from .util import get_primary_ip, utc_now_iso
from .package_manager import detect_package_manager

_SYSTEM = platform.system()  # "Linux", "Darwin", "Windows"

SKIP_FS_TYPES = {
    "proc",
    "sysfs",
    "tmpfs",
    "devtmpfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "overlay",
    "squashfs",
    "aufs",
    "rpc_pipefs",
    "nsfs",
    "fusectl",
    "securityfs",
    "pstore",
    "autofs",
    "mqueue",
    "hugetlbfs",
    "debugfs",
    "tracefs",
    "ramfs",
    "bpf"
}

MAX_REPO_LINES = 200


# ---------------------------------------------------------------------------
#  macOS helpers
# ---------------------------------------------------------------------------

def _sw_vers(flag):
    """Run sw_vers <flag> and return stripped output, or empty string."""
    try:
        result = subprocess.run(
            ["sw_vers", flag], capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _sysctl(key):
    """Return stripped output of `sysctl -n <key>`, or empty string."""
    try:
        result = subprocess.run(
            ["sysctl", "-n", key], capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _run_powershell_json(script, timeout=10):
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                f"{script} | ConvertTo-Json -Compress",
            ],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception:
        return None
    if result.returncode != 0 or not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def _windows_pretty_name():
    release = platform.release() or "Windows"
    version = platform.version()
    try:
        build = int(version.split(".")[-1])
    except (ValueError, IndexError):
        build = 0
    label = "11" if build >= 22000 else release
    return f"Windows {label}".strip()


# ---------------------------------------------------------------------------
#  OS info
# ---------------------------------------------------------------------------

def _read_os_release():
    """Parse /etc/os-release into a dictionary on Linux hosts."""
    data = {}
    path = Path("/etc/os-release")
    if not path.exists():
        return data
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        data[key.strip()] = value
    return data


def get_os_info():
    """Return a normalized OS summary regardless of platform."""
    if _SYSTEM == "Darwin":
        version = _sw_vers("-productVersion") or platform.mac_ver()[0] or platform.release()
        return {
            "name": "macOS",
            "version": version,
            "codename": "",
            "prettyName": f"macOS {version}"
        }
    if _SYSTEM == "Windows":
        version = platform.version()
        pretty = _windows_pretty_name()
        return {
            "name": "Windows",
            "version": version,
            "codename": "",
            "prettyName": pretty
        }
    data = _read_os_release()
    name = data.get("NAME") or platform.system()
    version = data.get("VERSION_ID") or platform.release()
    codename = data.get("VERSION_CODENAME") or ""
    pretty = data.get("PRETTY_NAME") or f"{name} {version}".strip()
    return {"name": name, "version": version, "codename": codename, "prettyName": pretty}


# ---------------------------------------------------------------------------
#  Uptime
# ---------------------------------------------------------------------------

def get_uptime_seconds():
    """Return uptime in seconds when the platform exposes it cleanly."""
    if _SYSTEM == "Darwin":
        raw = _sysctl("kern.boottime")
        # Output: { sec = 1740437742, usec = 0 } ...
        m = re.search(r"sec\s*=\s*(\d+)", raw)
        if m:
            try:
                return int(time.time() - int(m.group(1)))
            except ValueError:
                pass
        return None
    if _SYSTEM == "Windows" and ctypes is not None:
        try:
            return int(ctypes.windll.kernel32.GetTickCount64() / 1000)
        except Exception:
            return None

    path = Path("/proc/uptime")
    if path.exists():
        try:
            raw = path.read_text(encoding="utf-8", errors="ignore").split()[0]
            return int(float(raw))
        except (OSError, ValueError, IndexError):
            return None
    return None


# ---------------------------------------------------------------------------
#  Reboot required
# ---------------------------------------------------------------------------

def get_reboot_required():
    """Return whether the host is known to require a reboot."""
    if _SYSTEM == "Darwin":
        return False  # macOS does not use reboot-required files
    if _SYSTEM == "Windows" and winreg is not None:
        try:
            key = winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            )
            winreg.CloseKey(key)
            return True
        except OSError:
            return False
    if Path("/var/run/reboot-required").exists() or Path("/run/reboot-required").exists():
        return True
    needs_restarting = shutil.which("needs-restarting")
    if needs_restarting:
        try:
            result = subprocess.run(
                [needs_restarting, "-r"],
                capture_output=True,
                text=True,
                timeout=5
            )
        except (OSError, subprocess.SubprocessError):
            return False
        if result.returncode == 1:
            return True
        if result.returncode == 0:
            return False
    return False


# ---------------------------------------------------------------------------
#  CPU info
# ---------------------------------------------------------------------------

def _get_macos_cpu_info():
    # Model: Intel has machdep.cpu.brand_string; Apple Silicon uses hw.model
    model = _sysctl("machdep.cpu.brand_string")
    if not model:
        model = _sysctl("hw.model") or platform.processor() or "Unknown"

    # Physical cores
    cores = None
    raw = _sysctl("hw.physicalcpu")
    if raw.isdigit():
        cores = int(raw)

    # Logical cores
    threads = None
    raw = _sysctl("hw.logicalcpu")
    if raw.isdigit():
        threads = int(raw)

    if threads is None:
        threads = os.cpu_count() or 0
    if cores is None:
        cores = threads

    # CPU usage via top (2 samples, 0.1 s apart → second line is accurate)
    usage_percent = 0.0
    try:
        result = subprocess.run(
            ["top", "-l", "2", "-n", "0", "-s", "0.1"],
            capture_output=True, text=True, timeout=6
        )
        if result.returncode == 0:
            for line in reversed(result.stdout.splitlines()):
                if "CPU usage:" in line:
                    m = re.search(r"([\d.]+)%\s+idle", line)
                    if m:
                        usage_percent = round(100.0 - float(m.group(1)), 1)
                    break
    except Exception:
        pass

    return {
        "model": model,
        "cores": cores or 0,
        "threads": threads,
        "usagePercent": usage_percent
    }


def _get_windows_cpu_info():
    data = _run_powershell_json(
        "Get-CimInstance Win32_Processor | "
        "Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,LoadPercentage",
        timeout=8,
    )
    if isinstance(data, list):
        data = data[0] if data else {}
    data = data or {}
    return {
        "model": data.get("Name") or platform.processor() or "Unknown",
        "cores": data.get("NumberOfCores") or (os.cpu_count() or 0),
        "threads": data.get("NumberOfLogicalProcessors") or (os.cpu_count() or 0),
        "usagePercent": round(float(data.get("LoadPercentage") or 0), 1),
    }


def get_cpu_info():
    if _SYSTEM == "Darwin":
        return _get_macos_cpu_info()
    if _SYSTEM == "Windows":
        return _get_windows_cpu_info()

    model = ""
    cores = None
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("model name") and not model:
                model = line.split(":", 1)[1].strip()
            if line.startswith("cpu cores") and cores is None:
                try:
                    cores = int(line.split(":", 1)[1].strip())
                except ValueError:
                    cores = None
    if not model:
        model = platform.processor() or "Unknown"
    threads = os.cpu_count() or 0
    if not cores:
        cores = threads

    # Get CPU usage percentage via /proc/stat (two readings, 0.1 s apart)
    usage_percent = 0.0
    try:
        stat_path = Path("/proc/stat")
        if stat_path.exists():
            lines1 = stat_path.read_text().splitlines()
            cpu_line1 = next((l for l in lines1 if l.startswith("cpu ")), None)
            if cpu_line1:
                values1 = [int(x) for x in cpu_line1.split()[1:]]
                total1 = sum(values1)
                idle1 = values1[3]

                time.sleep(0.1)

                lines2 = stat_path.read_text().splitlines()
                cpu_line2 = next((l for l in lines2 if l.startswith("cpu ")), None)
                if cpu_line2:
                    values2 = [int(x) for x in cpu_line2.split()[1:]]
                    total2 = sum(values2)
                    idle2 = values2[3]

                    total_diff = total2 - total1
                    idle_diff = idle2 - idle1
                    if total_diff > 0:
                        usage_percent = 100.0 * (total_diff - idle_diff) / total_diff
    except Exception:
        pass

    return {
        "model": model,
        "cores": cores or 0,
        "threads": threads,
        "usagePercent": round(usage_percent, 1)
    }


# ---------------------------------------------------------------------------
#  Memory info
# ---------------------------------------------------------------------------

def _get_macos_memory_info():
    total = 0
    raw = _sysctl("hw.memsize")
    if raw.isdigit():
        total = int(raw)

    page_size = 4096
    free_pages = 0
    inactive_pages = 0
    try:
        result = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                m = re.search(r"page size of (\d+) bytes", line)
                if m:
                    page_size = int(m.group(1))
                    continue
                m = re.match(r"Pages free:\s+(\d+)", line)
                if m:
                    free_pages = int(m.group(1))
                    continue
                m = re.match(r"Pages inactive:\s+(\d+)", line)
                if m:
                    inactive_pages = int(m.group(1))
    except Exception:
        pass

    # Available = free + inactive (inactive pages are reclaimable)
    available = (free_pages + inactive_pages) * page_size
    used = max(0, total - available)
    return {
        "totalBytes": total,
        "availableBytes": available,
        "usedBytes": used
    }


def _read_meminfo():
    info = {}
    path = Path("/proc/meminfo")
    if not path.exists():
        return info
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        parts = value.strip().split()
        if not parts:
            continue
        try:
            info[key.strip()] = int(parts[0])
        except ValueError:
            continue
    return info


def _get_windows_memory_info():
    data = _run_powershell_json(
        "Get-CimInstance Win32_OperatingSystem | "
        "Select-Object TotalVisibleMemorySize,FreePhysicalMemory",
        timeout=8,
    )
    if isinstance(data, list):
        data = data[0] if data else {}
    data = data or {}
    total = int(data.get("TotalVisibleMemorySize") or 0) * 1024
    available = int(data.get("FreePhysicalMemory") or 0) * 1024
    used = total - available if total else 0
    return {
        "totalBytes": total,
        "availableBytes": available,
        "usedBytes": used,
    }


def get_memory_info():
    if _SYSTEM == "Darwin":
        return _get_macos_memory_info()
    if _SYSTEM == "Windows":
        return _get_windows_memory_info()

    info = _read_meminfo()
    total_kb = info.get("MemTotal") or 0
    avail_kb = info.get("MemAvailable") or info.get("MemFree") or 0
    total = total_kb * 1024
    available = avail_kb * 1024
    used = total - available if total else 0
    return {
        "totalBytes": total,
        "availableBytes": available,
        "usedBytes": used
    }


# ---------------------------------------------------------------------------
#  IP addresses
# ---------------------------------------------------------------------------

def _parse_ip_output(text):
    ips = []
    for line in text.splitlines():
        match = re.search(r"\sinet6?\s+([0-9a-fA-F:.]+)/", line)
        if not match:
            continue
        ip = match.group(1)
        if ip.startswith("127.") or ip == "::1":
            continue
        ips.append(ip)
    return ips


def _get_macos_ip_addresses():
    ips = []
    try:
        result = subprocess.run(
            ["ifconfig"], capture_output=True, text=True, timeout=3
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                # IPv4
                m = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)", line)
                if m:
                    ip = m.group(1)
                    if not ip.startswith("127."):
                        ips.append(ip)
                # IPv6 (skip link-local fe80::)
                m6 = re.search(r"\binet6\s+([0-9a-fA-F:]+)", line)
                if m6:
                    ip6 = m6.group(1)
                    if ip6 != "::1" and not ip6.lower().startswith("fe80"):
                        ips.append(ip6)
    except Exception:
        pass
    if not ips:
        primary = get_primary_ip()
        if primary and not primary.startswith("127."):
            ips.append(primary)
    return sorted(set(ips))


def _get_windows_ip_addresses():
    data = _run_powershell_json(
        "Get-NetIPAddress | "
        "Where-Object { $_.IPAddress -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -ne '::1' -and $_.IPAddress -notlike 'fe80*' } | "
        "Select-Object -ExpandProperty IPAddress",
        timeout=8,
    )
    if isinstance(data, str):
        return [data]
    if isinstance(data, list):
        return sorted(set([ip for ip in data if ip]))
    primary = get_primary_ip()
    return [primary] if primary else []


def get_ip_addresses():
    if _SYSTEM == "Darwin":
        return _get_macos_ip_addresses()
    if _SYSTEM == "Windows":
        return _get_windows_ip_addresses()

    ips = []
    ip_cmd = shutil.which("ip")
    if ip_cmd:
        for family in ("-4", "-6"):
            try:
                result = subprocess.run(
                    [ip_cmd, "-o", family, "addr", "show"],
                    capture_output=True,
                    text=True,
                    timeout=2
                )
            except (OSError, subprocess.SubprocessError):
                continue
            if result.returncode == 0:
                ips.extend(_parse_ip_output(result.stdout))
    if not ips:
        primary = get_primary_ip()
        if primary and not primary.startswith("127."):
            ips.append(primary)
    return sorted(set(ips))


# ---------------------------------------------------------------------------
#  Disks
# ---------------------------------------------------------------------------

def _get_macos_disks():
    disks = []
    try:
        result = subprocess.run(
            ["df", "-Pk"], capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            seen_devices = set()
            for line in result.stdout.splitlines()[1:]:  # skip header
                parts = line.split(None, 5)
                if len(parts) < 6:
                    continue
                device = parts[0]
                try:
                    size_kb = int(parts[1])
                    used_kb = int(parts[2])
                    avail_kb = int(parts[3])
                except ValueError:
                    continue
                mount = parts[5].strip()

                if size_kb == 0:
                    continue
                # Skip virtual filesystems
                if device in ("devfs", "none") or device.startswith("map "):
                    continue
                # Skip internal system-only APFS volumes (keep Data volume and /Volumes/*)
                if mount.startswith("/System/Volumes/") and mount != "/System/Volumes/Data":
                    continue
                if mount in {"/private/var/vm", "/dev"}:
                    continue
                if device in seen_devices:
                    continue
                seen_devices.add(device)

                disks.append({
                    "device": device,
                    "mount": mount,
                    "fsType": "apfs",
                    "sizeBytes": size_kb * 1024,
                    "usedBytes": used_kb * 1024,
                    "availBytes": avail_kb * 1024
                })
    except Exception:
        pass
    return disks


def _get_windows_disks():
    data = _run_powershell_json(
        "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | "
        "Select-Object DeviceID,FileSystem,Size,FreeSpace",
        timeout=10,
    )
    if isinstance(data, dict):
        data = [data]
    disks = []
    for entry in data or []:
        size = int(entry.get("Size") or 0)
        free = int(entry.get("FreeSpace") or 0)
        disks.append(
            {
                "device": entry.get("DeviceID") or "?",
                "mount": entry.get("DeviceID") or "?",
                "fsType": entry.get("FileSystem") or "ntfs",
                "sizeBytes": size,
                "usedBytes": max(0, size - free),
                "availBytes": free,
            }
        )
    return disks


def get_disks():
    if _SYSTEM == "Darwin":
        return _get_macos_disks()
    if _SYSTEM == "Windows":
        return _get_windows_disks()

    disks = []
    mounts = Path("/proc/mounts")
    if not mounts.exists():
        return disks
    seen = set()
    for line in mounts.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        device, mount, fstype = parts[0], parts[1], parts[2]
        if fstype in SKIP_FS_TYPES:
            continue
        if mount.startswith("/snap"):
            continue
        if mount in seen:
            continue
        seen.add(mount)
        try:
            stats = os.statvfs(mount)
        except OSError:
            continue
        size = stats.f_blocks * stats.f_frsize
        avail = stats.f_bavail * stats.f_frsize
        used = (stats.f_blocks - stats.f_bfree) * stats.f_frsize
        disks.append(
            {
                "device": device,
                "mount": mount,
                "fsType": fstype,
                "sizeBytes": size,
                "usedBytes": used,
                "availBytes": avail
            }
        )
    return disks


# ---------------------------------------------------------------------------
#  GPU info
# ---------------------------------------------------------------------------

def get_gpu_info():
    if _SYSTEM == "Windows":
        data = _run_powershell_json(
            "Get-CimInstance Win32_VideoController | Select-Object Name",
            timeout=8,
        )
        if isinstance(data, dict):
            data = [data]
        return [entry.get("Name") for entry in data or [] if entry.get("Name")]

    gpus = []
    lspci = shutil.which("lspci")
    if not lspci:
        return gpus
    try:
        result = subprocess.run(
            [lspci],
            capture_output=True,
            text=True,
            timeout=3
        )
    except (OSError, subprocess.SubprocessError):
        return gpus
    if result.returncode != 0:
        return gpus
    for line in result.stdout.splitlines():
        if "VGA compatible controller" in line or "3D controller" in line or "Display controller" in line:
            cleaned = re.sub(r"^[0-9a-fA-F:.]+\s+", "", line).strip()
            gpus.append(cleaned)
    return gpus


# ---------------------------------------------------------------------------
#  Repositories
# ---------------------------------------------------------------------------

def _read_sources_list(path):
    entries = []
    if not path.exists():
        return entries
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        cleaned = line.split("#", 1)[0].strip()
        if not cleaned:
            continue
        entries.append(cleaned)
    return entries


def _dedupe_repos(entries):
    deduped = []
    seen = set()
    for entry in entries:
        if entry in seen:
            continue
        seen.add(entry)
        deduped.append(entry)
        if len(deduped) >= MAX_REPO_LINES:
            break
    return deduped


def _get_apt_repos():
    repos = []
    repos.extend(_read_sources_list(Path("/etc/apt/sources.list")))
    sources_dir = Path("/etc/apt/sources.list.d")
    if sources_dir.exists():
        for path in sorted(sources_dir.glob("*.list")):
            repos.extend(_read_sources_list(path))
    return _dedupe_repos(repos)


def _parse_repo_file(path):
    entries = []
    repo_id = None
    name = None
    baseurl = None
    mirrorlist = None

    def flush():
        if not repo_id:
            return
        detail = baseurl or mirrorlist or name
        if detail:
            entries.append(f"{repo_id} | {detail}")
        else:
            entries.append(repo_id)

    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        cleaned = line.split("#", 1)[0].strip()
        if not cleaned:
            continue
        if cleaned.startswith("[") and cleaned.endswith("]"):
            flush()
            repo_id = cleaned[1:-1].strip()
            name = None
            baseurl = None
            mirrorlist = None
            continue
        if "=" not in cleaned:
            continue
        key, value = cleaned.split("=", 1)
        key = key.strip().lower()
        value = value.strip()
        if key == "name":
            name = value
        elif key == "baseurl":
            baseurl = value
        elif key == "mirrorlist":
            mirrorlist = value
    flush()
    return entries


def _get_dnf_repos():
    repos = []
    sources_dir = Path("/etc/yum.repos.d")
    if sources_dir.exists():
        for path in sorted(sources_dir.glob("*.repo")):
            repos.extend(_parse_repo_file(path))
    return _dedupe_repos(repos)


def _get_pacman_repos():
    repos = []
    config_path = Path("/etc/pacman.conf")
    if not config_path.exists():
        return repos
    for line in config_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        cleaned = line.split("#", 1)[0].strip()
        if cleaned.startswith("[") and cleaned.endswith("]"):
            section = cleaned[1:-1].strip()
            if section and section.lower() != "options":
                repos.append(section)
    return _dedupe_repos(repos)


def _get_brew_taps():
    brew = shutil.which("brew")
    if not brew:
        return []
    try:
        result = subprocess.run(
            [brew, "tap"], capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            return [l.strip() for l in result.stdout.splitlines() if l.strip()]
    except Exception:
        pass
    return []


def _get_winget_sources():
    data = _run_powershell_json("winget source list | Select-Object -Skip 1", timeout=15)
    if isinstance(data, str):
        return [data]
    if isinstance(data, list):
        return [str(entry).strip() for entry in data if str(entry).strip()]
    return []


def get_repositories():
    manager = detect_package_manager()
    if manager == "macos":
        return _get_brew_taps()
    if manager == "windows":
        return _get_winget_sources()
    if manager == "apt":
        return _get_apt_repos()
    if manager in ("dnf", "yum"):
        return _get_dnf_repos()
    if manager == "pacman":
        return _get_pacman_repos()
    return []


# ---------------------------------------------------------------------------
#  Package count
# ---------------------------------------------------------------------------

def _get_dpkg_count():
    dpkg_query = shutil.which("dpkg-query")
    if dpkg_query:
        try:
            result = subprocess.run(
                [dpkg_query, "-f", "${Package}\n", "-W"],
                capture_output=True,
                text=True,
                timeout=5
            )
            if result.returncode == 0:
                return len([line for line in result.stdout.splitlines() if line.strip()])
        except (OSError, subprocess.SubprocessError):
            pass
    status_path = Path("/var/lib/dpkg/status")
    if status_path.exists():
        count = 0
        for line in status_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("Package:"):
                count += 1
        return count
    return 0


def _get_rpm_count():
    rpm = shutil.which("rpm")
    if rpm:
        try:
            result = subprocess.run(
                [rpm, "-qa"],
                capture_output=True,
                text=True,
                timeout=6
            )
            if result.returncode == 0:
                return len([line for line in result.stdout.splitlines() if line.strip()])
        except (OSError, subprocess.SubprocessError):
            pass
    return 0


def _get_brew_count():
    # brew lives outside root's PATH and refuses to run as root; reuse the
    # resolver from lib.packages (correct path + run as the install owner).
    try:
        from .packages import _run_brew
        code, out, _ = _run_brew(["list", "--formula"], 20)
        if code == 0:
            return len([l for l in out.splitlines() if l.strip()])
    except Exception:
        pass
    return 0


def _get_pacman_count():
    pacman = shutil.which("pacman")
    if not pacman:
        return 0
    try:
        result = subprocess.run(
            [pacman, "-Qq"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if result.returncode == 0:
            return len([line for line in result.stdout.splitlines() if line.strip()])
    except Exception:
        pass
    return 0


def _get_winget_count():
    winget = shutil.which("winget")
    if not winget:
        return 0
    try:
        result = subprocess.run(
            [winget, "list"],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode == 0:
            rows = [line for line in result.stdout.splitlines() if line.strip()]
            return max(0, len(rows) - 1)
    except Exception:
        pass
    return 0


def get_package_count():
    manager = detect_package_manager()
    if manager == "macos":
        return _get_brew_count()
    if manager == "windows":
        return _get_winget_count()
    if manager == "apt":
        return _get_dpkg_count()
    if manager in ("dnf", "yum"):
        return _get_rpm_count()
    if manager == "pacman":
        return _get_pacman_count()
    count = _get_dpkg_count()
    if count:
        return count
    return _get_rpm_count()


# ---------------------------------------------------------------------------
#  collect_system_info
# ---------------------------------------------------------------------------

def collect_system_info():
    manager = detect_package_manager()
    return {
        "collectedAt": utc_now_iso(),
        "os": get_os_info(),
        "packageManager": manager,
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "gpu": get_gpu_info(),
        "ips": get_ip_addresses(),
        "disks": get_disks(),
        "repositories": get_repositories(),
        "packagesInstalled": get_package_count(),
        "uptimeSeconds": get_uptime_seconds(),
        "rebootRequired": get_reboot_required()
    }
