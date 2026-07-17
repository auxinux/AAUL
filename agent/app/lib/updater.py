import shutil
import tarfile
import tempfile
import subprocess
import hashlib
import hmac
from pathlib import Path

from .api import api_get
from .config import APP_DIR, RUNTIME_DIR, VENV_DIR


class UpdateError(RuntimeError):
    pass


def _safe_extract(archive, target_dir):
    target_dir = Path(target_dir).resolve()
    for member in archive.getmembers():
        if member.issym() or member.islnk():
            raise UpdateError("Bundle contains unsupported link entries")
        member_path = (target_dir / member.name).resolve()
        if member_path != target_dir and target_dir not in member_path.parents:
            raise UpdateError("Bundle contains unsafe paths")
    archive.extractall(path=target_dir)


def _file_sha256(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def update_agent(config, verbose=False):
    def log(message):
        if verbose:
            print(message)

    log("Downloading agent bundle...")
    bundle_response = api_get(config, "/agent/latest.tar.gz", timeout=30, stream=True)
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="agentautoupdate-", dir=str(RUNTIME_DIR)))
    bundle_path = temp_dir / "latest.tar.gz"

    with bundle_path.open("wb") as handle:
        for chunk in bundle_response.iter_content(chunk_size=1024 * 1024):
            if chunk:
                handle.write(chunk)

    expected_sha256 = (bundle_response.headers.get("X-Bundle-Sha256") or "").strip().lower()
    provided_signature = (bundle_response.headers.get("X-Bundle-Signature") or "").strip().lower()
    if not expected_sha256 or not provided_signature:
        raise UpdateError("Bundle integrity metadata missing")

    actual_sha256 = _file_sha256(bundle_path)
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise UpdateError("Bundle checksum mismatch")

    expected_signature = hmac.new(
        config["agentApiToken"].encode("utf-8"),
        expected_sha256.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected_signature, provided_signature):
        raise UpdateError("Bundle signature verification failed")

    new_app_dir = temp_dir / "app"
    new_app_dir.mkdir(parents=True, exist_ok=True)

    log("Extracting bundle...")
    with tarfile.open(bundle_path, "r:gz") as archive:
        _safe_extract(archive, new_app_dir)

    version_path = new_app_dir / "VERSION"
    if not version_path.exists():
        raise UpdateError("Bundle missing VERSION file")
    new_version = version_path.read_text().strip()

    current_dir = APP_DIR
    backup_dir = Path(str(APP_DIR) + ".bak")

    log("Swapping application directory...")
    if backup_dir.exists():
        shutil.rmtree(backup_dir)
    if current_dir.exists():
        current_dir.rename(backup_dir)

    new_app_dir.rename(current_dir)

    if backup_dir.exists():
        shutil.rmtree(backup_dir)

    # Ensure dependencies are installed/updated
    try:
        windows_pip = VENV_DIR / "Scripts" / "pip.exe"
        unix_pip = VENV_DIR / "bin" / "pip"
        venv_pip = windows_pip if windows_pip.exists() else unix_pip
        requirements = current_dir / "requirements.txt"
        if venv_pip.exists() and requirements.exists():
            log("Installing Python dependencies...")
            subprocess.run(
                [str(venv_pip), "install", "-r", str(requirements)],
                check=False
            )
    except Exception as exc:
        log(f"Dependency install skipped: {exc}")

    log("Cleaning up...")
    shutil.rmtree(temp_dir)

    log(f"Update complete. Version {new_version}.")
    return new_version
