"""
Remote package management for the agent.

SECURITY MODEL (defense in depth — the dashboard validates too, but the agent
NEVER trusts the dashboard blindly):

- Commands are executed ONLY through fixed argument lists (no shell, ever), so
  package names can never be interpreted as shell syntax.
- Package names are validated against a strict allowlist charset. Anything with
  a space, path separator, URL, shell metacharacter, etc. is rejected.
- A hardcoded BLACKLIST blocks install/removal of boot/system-critical packages
  (bootloader, kernel, init, libc, the package manager itself…), so this feature
  can never be abused to brick a machine.
- Installs are by NAME from the system's configured repositories only — no
  arbitrary URLs, .deb/.rpm files or local paths.
- Listing and searching are read-only and always allowed; install/remove are
  gated server-side by an explicit per-agent opt-in.
"""
import re
import subprocess
import os

from .package_manager import detect_package_manager
from .logs import log

# Strict package-name charset. Must start alphanumeric; then a small safe set.
PACKAGE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,100}$")
# Search queries may contain spaces but no control/shell characters.
SEARCH_QUERY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,100}$")

# Boot / system critical packages that must never be installed or removed here.
_BLACKLIST_PATTERNS = [
    r"^grub", r"grub2", r"grub-",
    r"^linux-image", r"^linux-headers", r"^linux-firmware",
    r"^kernel", r"-kernel", r"^linux$", r"^linux-lts",
    r"^systemd$", r"^systemd-", r"^init$", r"^sysvinit", r"^upstart$",
    r"^libc6$", r"^glibc", r"^libc-bin$", r"^musl$",
    r"^dpkg$", r"^apt$", r"^apt-get$", r"^rpm$", r"^dnf$", r"^yum$",
    r"^pacman$", r"^zypper$", r"^portage$",
    r"^bash$", r"^dash$", r"^coreutils$", r"^util-linux$",
    r"^shim", r"^efibootmgr$", r"^os-prober$",
    r"^mkinitcpio$", r"^dracut$", r"^initramfs-tools",
    r"^syslinux", r"^refind", r"^bootctl$", r"^sudo$",
]
_BLACKLIST = [re.compile(p) for p in _BLACKLIST_PATTERNS]

_TIMEOUT = 300  # seconds for install/remove
_QUERY_TIMEOUT = 60


class PackageError(Exception):
    pass


def is_blacklisted(name: str) -> bool:
    """True if the package is boot/system-critical and must be protected."""
    low = (name or "").strip().lower()
    return any(rx.search(low) for rx in _BLACKLIST)


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not PACKAGE_NAME_RE.match(name):
        raise PackageError("Nom de paquet invalide")
    if is_blacklisted(name):
        raise PackageError("Paquet protégé (critique pour le système) — opération refusée")
    return name


def _validate_query(query: str) -> str:
    query = (query or "").strip()
    if not SEARCH_QUERY_RE.match(query):
        raise PackageError("Requête de recherche invalide")
    return query


def _run(cmd, timeout, add_sudo=True):
    """Run a fixed argument list without a shell. Adds sudo on Linux if needed."""
    if add_sudo and os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() != 0:
        cmd = ["sudo", "-n"] + cmd
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except FileNotFoundError:
        raise PackageError(f"Commande introuvable: {cmd[0]}")
    except subprocess.TimeoutExpired:
        raise PackageError("Délai dépassé")


# Homebrew lives outside root's PATH and refuses to run as root, so we resolve
# its real path and run it as the user that owns the install.
_BREW_PATHS = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]


def _find_brew():
    import shutil
    found = shutil.which("brew")
    if found:
        return found
    for path in _BREW_PATHS:
        if os.path.exists(path):
            return path
    return None


def _brew_cmd(args):
    """Build a brew command, dropping privileges to the brew owner if we are root."""
    brew = _find_brew()
    if not brew:
        raise PackageError("Homebrew introuvable (installez-le, ou il n'est pas dans le PATH)")
    cmd = [brew] + args
    if os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() == 0:
        try:
            import pwd
            owner = pwd.getpwuid(os.stat(brew).st_uid).pw_name
        except Exception:
            owner = None
        if owner and owner != "root":
            # Run brew as its owner with a usable HOME so it behaves normally.
            cmd = ["sudo", "-u", owner, "-i"] + cmd
    return cmd


def _run_brew(args, timeout):
    # We build privilege handling ourselves, so don't let _run prepend sudo.
    return _run(_brew_cmd(args), timeout, add_sudo=False)


# ---------------------------------------------------------------------------
#  Listing installed packages
# ---------------------------------------------------------------------------
def list_installed():
    mgr = detect_package_manager()
    packages = []

    if mgr == "apt":
        code, out, _ = _run(["dpkg-query", "-W", "-f=${Package}\t${Version}\n"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split("\t")
            if parts and parts[0]:
                packages.append({"name": parts[0], "version": parts[1] if len(parts) > 1 else ""})
    elif mgr in ("dnf", "yum", "zypper"):
        code, out, _ = _run(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\n"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split("\t")
            if parts and parts[0]:
                packages.append({"name": parts[0], "version": parts[1] if len(parts) > 1 else ""})
    elif mgr == "pacman":
        code, out, _ = _run(["pacman", "-Q"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split(" ", 1)
            if parts and parts[0]:
                packages.append({"name": parts[0], "version": parts[1] if len(parts) > 1 else ""})
    elif mgr == "macos":
        code, out, _ = _run_brew(["list", "--versions"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split(" ", 1)
            if parts and parts[0]:
                packages.append({"name": parts[0], "version": parts[1] if len(parts) > 1 else ""})
    elif mgr == "windows":
        code, out, _ = _run(["winget", "list"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            line = line.strip()
            if line and not line.startswith("-"):
                packages.append({"name": line, "version": ""})
    else:
        raise PackageError("Gestionnaire de paquets non supporté")

    packages.sort(key=lambda p: p["name"].lower())
    return {"manager": mgr, "packages": packages, "count": len(packages)}


# ---------------------------------------------------------------------------
#  Searching available packages
# ---------------------------------------------------------------------------
def search(query: str):
    query = _validate_query(query)
    mgr = detect_package_manager()
    results = []

    def add(name, summary=""):
        if name:
            results.append({"name": name, "summary": summary.strip()})

    if mgr == "apt":
        code, out, _ = _run(["apt-cache", "search", "--names-only", query], _QUERY_TIMEOUT)
        for line in out.splitlines():
            if " - " in line:
                name, summary = line.split(" - ", 1)
                add(name.strip(), summary)
            elif line.strip():
                add(line.strip())
    elif mgr in ("dnf", "yum"):
        code, out, _ = _run([mgr, "-q", "search", query], _QUERY_TIMEOUT)
        for line in out.splitlines():
            if " : " in line:
                name, summary = line.split(" : ", 1)
                add(name.split(".")[0].strip(), summary)
    elif mgr == "zypper":
        code, out, _ = _run(["zypper", "--non-interactive", "search", query], _QUERY_TIMEOUT)
        for line in out.splitlines():
            cols = [c.strip() for c in line.split("|")]
            if len(cols) >= 3 and cols[1] and cols[1].lower() != "name":
                add(cols[1], cols[2] if len(cols) > 2 else "")
    elif mgr == "pacman":
        code, out, _ = _run(["pacman", "-Ss", query], _QUERY_TIMEOUT)
        current = None
        for line in out.splitlines():
            if line and not line.startswith(" ") and "/" in line:
                name = line.split("/", 1)[1].split(" ", 1)[0]
                current = name
                add(name)
            elif line.startswith(" ") and current and results:
                results[-1]["summary"] = line.strip()
    elif mgr == "macos":
        code, out, _ = _run_brew(["search", query], _QUERY_TIMEOUT)
        for line in out.splitlines():
            if line.strip() and not line.startswith("=="):
                add(line.strip())
    elif mgr == "windows":
        code, out, _ = _run(["winget", "search", query], _QUERY_TIMEOUT)
        for line in out.splitlines():
            line = line.strip()
            if line and not line.startswith("-") and not line.lower().startswith("name"):
                add(line)
    else:
        raise PackageError("Gestionnaire de paquets non supporté")

    # Cap the payload to keep responses reasonable.
    return {"manager": mgr, "query": query, "results": results[:200]}


# ---------------------------------------------------------------------------
#  Install / remove
# ---------------------------------------------------------------------------
def _install_cmd(mgr, name):
    return {
        "apt": ["apt-get", "install", "-y", name],
        "dnf": ["dnf", "install", "-y", name],
        "yum": ["yum", "install", "-y", name],
        "zypper": ["zypper", "--non-interactive", "install", name],
        "pacman": ["pacman", "-S", "--noconfirm", name],
        "macos": ["brew", "install", name],
        "windows": ["winget", "install", "--silent", "--accept-package-agreements",
                    "--accept-source-agreements", "--exact", "--id", name],
    }.get(mgr)


def _remove_cmd(mgr, name):
    return {
        "apt": ["apt-get", "remove", "-y", name],
        "dnf": ["dnf", "remove", "-y", name],
        "yum": ["yum", "remove", "-y", name],
        "zypper": ["zypper", "--non-interactive", "remove", name],
        "pacman": ["pacman", "-R", "--noconfirm", name],
        "macos": ["brew", "uninstall", name],
        "windows": ["winget", "uninstall", "--silent", "--exact", "--id", name],
    }.get(mgr)


def install(name: str):
    name = _validate_name(name)
    mgr = detect_package_manager()
    log(f"[packages] install {name} via {mgr}")
    if mgr == "macos":
        code, out, err = _run_brew(["install", name], _TIMEOUT)
    else:
        cmd = _install_cmd(mgr, name)
        if not cmd:
            raise PackageError("Gestionnaire de paquets non supporté")
        if mgr == "apt":
            _run(["apt-get", "update"], _QUERY_TIMEOUT)
        code, out, err = _run(cmd, _TIMEOUT)
    success = code == 0
    return {
        "action": "install",
        "name": name,
        "manager": mgr,
        "success": success,
        "output": (out + ("\n" + err if err else ""))[-4000:],
    }


def remove(name: str):
    name = _validate_name(name)
    mgr = detect_package_manager()
    log(f"[packages] remove {name} via {mgr}")
    if mgr == "macos":
        code, out, err = _run_brew(["uninstall", name], _TIMEOUT)
    else:
        cmd = _remove_cmd(mgr, name)
        if not cmd:
            raise PackageError("Gestionnaire de paquets non supporté")
        code, out, err = _run(cmd, _TIMEOUT)
    success = code == 0
    return {
        "action": "remove",
        "name": name,
        "manager": mgr,
        "success": success,
        "output": (out + ("\n" + err if err else ""))[-4000:],
    }


# ---------------------------------------------------------------------------
#  Available updates: detect (no install) and apply selected
# ---------------------------------------------------------------------------
def check_updates():
    """Return the list of available updates WITHOUT installing anything."""
    mgr = detect_package_manager()
    updates = []

    def add(name, detail=""):
        if name:
            updates.append({"name": name, "detail": detail.strip()})

    if mgr == "apt":
        _run(["apt-get", "update"], _QUERY_TIMEOUT)
        code, out, _ = _run(["apt", "list", "--upgradable"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            if "/" in line and not line.startswith("Listing"):
                name = line.split("/", 1)[0].strip()
                add(name, line.split("]")[-1].strip() if "[" in line else "")
    elif mgr in ("dnf", "yum"):
        code, out, _ = _run([mgr, "-q", "check-update"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split()
            if len(parts) >= 2 and "." in parts[0] and not line.startswith(("Last", "Obsoleting", "Security")):
                add(parts[0], parts[1])
    elif mgr == "zypper":
        code, out, _ = _run(["zypper", "-q", "list-updates"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            cols = [c.strip() for c in line.split("|")]
            if len(cols) >= 4 and cols[2] and cols[2].lower() not in ("name", ""):
                add(cols[2], f"{cols[3]} → {cols[4]}" if len(cols) > 4 else "")
    elif mgr == "pacman":
        code, out, _ = _run(["pacman", "-Qu"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            parts = line.split()
            if parts:
                add(parts[0], " ".join(parts[1:]))
    elif mgr == "macos":
        code, out, _ = _run_brew(["outdated", "--verbose"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            if line.strip():
                add(line.split(" ", 1)[0], line)
        # OS-level updates (informational; applied via full update)
        oc, oout, _ = _run(["softwareupdate", "-l"], _QUERY_TIMEOUT)
        for line in oout.splitlines():
            s = line.strip()
            if s.startswith("* Label:"):
                add(s.replace("* Label:", "").strip(), "macOS update")
            elif s.startswith("Title:"):
                if updates:
                    updates[-1]["detail"] = s
    elif mgr == "windows":
        code, out, _ = _run(["winget", "upgrade"], _QUERY_TIMEOUT)
        for line in out.splitlines():
            line = line.strip()
            if line and not line.startswith("-") and not line.lower().startswith("name"):
                add(line)
    else:
        raise PackageError("Gestionnaire de paquets non supporté")

    return {"manager": mgr, "updates": updates, "count": len(updates)}


def update_packages(names):
    """Upgrade only the given packages (validated + blacklisted)."""
    if not isinstance(names, list) or not names:
        raise PackageError("Aucun paquet spécifié")
    clean = [_validate_name(n) for n in names]
    mgr = detect_package_manager()
    log(f"[packages] update {len(clean)} package(s) via {mgr}")

    if mgr == "apt":
        _run(["apt-get", "update"], _QUERY_TIMEOUT)
        cmd = ["apt-get", "install", "-y", "--only-upgrade"] + clean
    elif mgr == "dnf":
        cmd = ["dnf", "upgrade", "-y"] + clean
    elif mgr == "yum":
        cmd = ["yum", "upgrade", "-y"] + clean
    elif mgr == "zypper":
        cmd = ["zypper", "--non-interactive", "update"] + clean
    elif mgr == "pacman":
        cmd = ["pacman", "-S", "--noconfirm"] + clean
    elif mgr == "macos":
        code, out, err = _run_brew(["upgrade"] + clean, _TIMEOUT)
        return {"action": "update", "manager": mgr, "names": clean,
                "success": code == 0, "output": (out + ("\n" + err if err else ""))[-4000:]}
    else:
        raise PackageError("Gestionnaire de paquets non supporté")

    code, out, err = _run(cmd, _TIMEOUT)
    return {"action": "update", "manager": mgr, "names": clean,
            "success": code == 0, "output": (out + ("\n" + err if err else ""))[-4000:]}
