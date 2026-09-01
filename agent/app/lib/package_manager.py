"""Update command selection per operating system.

The rest of the agent does not need to know which package manager is in use.
This module answers two simple questions:

- what environment are we running on?
- which commands should be executed to apply updates there?
"""
import platform
import shutil


def detect_package_manager():
    """Return the package/update system name for the current host."""
    system = platform.system()

    if system == "Darwin":
        return "macos"

    if system == "Windows":
        return "windows"

    if shutil.which("apt-get"):
        return "apt"
    if shutil.which("dnf"):
        return "dnf"
    if shutil.which("yum"):
        return "yum"
    if shutil.which("pacman"):
        return "pacman"
    if shutil.which("zypper"):
        return "zypper"

    return "unknown"


def _windows_update_command():
    """Return a PowerShell command that drives the native Windows Update COM API."""
    script = (
        "$session = New-Object -ComObject Microsoft.Update.Session;"
        "$searcher = $session.CreateUpdateSearcher();"
        "$result = $searcher.Search(\"IsInstalled=0 and Type='Software'\");"
        "if ($result.Updates.Count -eq 0) { exit 0 };"
        "$updates = New-Object -ComObject Microsoft.Update.UpdateColl;"
        "foreach ($update in $result.Updates) {"
        "  if (-not $update.EulaAccepted) { $update.AcceptEula() | Out-Null };"
        "  [void]$updates.Add($update)"
        "};"
        "$downloader = $session.CreateUpdateDownloader();"
        "$downloader.Updates = $updates;"
        "$downloadResult = $downloader.Download();"
        "if ($downloadResult.ResultCode -gt 3) { exit 1 };"
        "$installer = $session.CreateUpdateInstaller();"
        "$installer.Updates = $updates;"
        "$installResult = $installer.Install();"
        "if ($installResult.ResultCode -gt 3) { exit 1 }"
    )
    return [
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]


def get_update_commands():
    """Return the ordered list of update commands for the current host.

    The caller is responsible for executing these commands with the right
    privileges and streaming/logging the output.
    """
    manager = detect_package_manager()

    if manager == "apt":
        return [
            ["apt-get", "update"],
            ["apt-get", "full-upgrade", "-y"],
            ["apt-get", "autoremove", "-y"],
            ["apt-get", "autoclean", "-y"],
        ]

    if manager in ("dnf", "yum"):
        cmd = "dnf" if manager == "dnf" else "yum"
        return [
            [cmd, "-y", "makecache"],
            [cmd, "-y", "upgrade"],
            [cmd, "-y", "autoremove"],
            [cmd, "-y", "clean", "all"],
        ]

    if manager == "zypper":
        return [
            ["zypper", "--non-interactive", "refresh"],
            ["zypper", "--non-interactive", "update"],
        ]

    if manager == "pacman":
        return [["pacman", "-Syu", "--noconfirm"]]

    if manager == "macos":
        commands = []
        if shutil.which("brew"):
            commands.extend(
                [
                    ["brew", "update"],
                    ["brew", "upgrade"],
                    ["brew", "cleanup"],
                ]
            )
        commands.append(["softwareupdate", "--install", "--all"])
        return commands

    if manager == "windows":
        commands = []
        if shutil.which("winget"):
            commands.append(
                [
                    "winget",
                    "upgrade",
                    "--all",
                    "--silent",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                ]
            )
        commands.append(_windows_update_command())
        return commands

    return []
