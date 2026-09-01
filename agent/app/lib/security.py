"""TLS and request-signing helpers used by the agent's HTTP client (lib/api.py)."""

import hashlib
import hmac
import json
import os
import ssl
import time

from .config import SECURITY_CONFIG_PATH


def load_security_config():
    """Load security configuration."""
    if not SECURITY_CONFIG_PATH.exists():
        return {
            "verifyTls": True,
            "allowSelfSigned": False,
            "signRequests": True
        }
    try:
        return json.loads(SECURITY_CONFIG_PATH.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"verifyTls": True, "allowSelfSigned": False, "signRequests": True}


def save_security_config(config):
    """Save security configuration."""
    SECURITY_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    SECURITY_CONFIG_PATH.write_text(
        json.dumps(config, indent=2),
        encoding="utf-8"
    )


def get_ssl_context(allow_self_signed=False):
    """Build the SSL context used for the dashboard connection."""
    context = ssl.create_default_context()

    if allow_self_signed:
        # CERT_OPTIONAL (not CERT_NONE) so the connection is still encrypted
        # even though the certificate itself isn't validated.
        import warnings
        warnings.warn(
            "allowSelfSigned=True: TLS certificate verification is weakened. "
            "Use only for development/testing.",
            stacklevel=2,
        )
        context.check_hostname = False
        context.verify_mode = ssl.CERT_OPTIONAL
    else:
        context.check_hostname = True
        context.verify_mode = ssl.CERT_REQUIRED
        context.load_default_certs()

    context.minimum_version = ssl.TLSVersion.TLSv1_2

    return context


def generate_nonce():
    return os.urandom(16).hex()


def generate_timestamp():
    return str(int(time.time()))


def sign_request(payload, secret_key, nonce=None, timestamp=None):
    """HMAC-SHA256 sign a request payload. Returns the X-Signature/-Timestamp/-Nonce headers."""
    if nonce is None:
        nonce = generate_nonce()
    if timestamp is None:
        timestamp = generate_timestamp()

    payload_json = json.dumps(payload, sort_keys=True, separators=(',', ':'))
    message = f"{timestamp}.{nonce}.{payload_json}"

    signature = hmac.new(
        secret_key.encode('utf-8'),
        message.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

    return {
        "X-Signature": signature,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce
    }
