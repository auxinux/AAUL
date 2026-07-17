"""HTTP client used by the agent to talk to the dashboard.

The agent only has two request patterns in practice:

- JSON POST requests for poll / command-result style endpoints
- GET requests for bundle downloads and lightweight reads

This module keeps that communication logic in one place so the rest of the
agent does not have to deal with retries, TLS flags, or signing headers.
"""

import hashlib
import hmac
import time

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from .security import (
    get_ssl_context,
    sign_request,
    load_security_config
)


def _verify_response_signature(response, secret_key, max_age=300):
    signature = (response.headers.get("X-Response-Signature") or "").strip()
    timestamp = (response.headers.get("X-Response-Timestamp") or "").strip()
    nonce = (response.headers.get("X-Response-Nonce") or "").strip()
    if not signature or not timestamp or not nonce:
        raise RuntimeError("Missing response signature")

    try:
        response_time = int(timestamp)
    except (TypeError, ValueError):
        raise RuntimeError("Invalid response signature timestamp")
    if abs(int(time.time()) - response_time) > max_age:
        raise RuntimeError("Expired response signature")

    body_text = response.text
    message = f"{timestamp}.{nonce}.{body_text}"
    expected = hmac.new(
        secret_key.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise RuntimeError("Invalid response signature")


def create_session(timeout=10, retries=3):
    """
    Create a requests session with retry logic.

    The agent mostly performs short-lived requests, so a small retry window is
    enough to smooth over transient network errors without hiding real outages.
    """
    session = requests.Session()
    
    retry_strategy = Retry(
        total=retries,
        backoff_factor=1,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET", "POST"]
    )
    
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    
    return session


def api_post(config, path, payload, timeout=10, extra_headers=None):
    """
    Send a POST request to the dashboard API.
    
    Args:
        config: Agent configuration dictionary
        path: API endpoint path (e.g., '/api/agent/poll')
        payload: JSON payload to send
        timeout: Request timeout in seconds
        extra_headers: Optional additional headers
        
    Returns:
        Parsed JSON response
        
    Raises:
        RuntimeError: If request fails
    """
    url = f"{config['dashboardUrl'].rstrip('/')}{path}"
    
    # Every agent request is authenticated; mutable requests may also be signed.
    headers = {
        "Authorization": f"Bearer {config['agentApiToken']}",
        "Content-Type": "application/json",
        "User-Agent": "AgentAutoUpdate/1.0"
    }
    
    if extra_headers:
        headers.update(extra_headers)
    
    security_config = load_security_config()

    # Serialize ONCE and send these exact bytes. The signature is computed over
    # the same canonical string, so the server can verify the raw body directly
    # (no JSON re-serialization agreement needed: immune to float/key-order/
    # unicode formatting differences between Python and Node).
    import json as _json
    body_text = _json.dumps(payload, sort_keys=True, separators=(',', ':'))
    body_bytes = body_text.encode("utf-8")

    if security_config.get("signRequests", False):
        signature_headers = sign_request(payload, config['agentApiToken'])
        headers.update(signature_headers)

    verify_ssl = security_config.get("verifyTls", True)
    if security_config.get("allowSelfSigned", False):
        verify_ssl = False

    try:
        response = requests.post(
            url,
            data=body_bytes,
            headers=headers,
            timeout=timeout,
            verify=verify_ssl
        )
        
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text}")

        if security_config.get("verifyResponses", security_config.get("signRequests", True)):
            _verify_response_signature(response, config["agentApiToken"])

        return response.json()
        
    except requests.exceptions.SSLError as e:
        raise RuntimeError(f"SSL Error: {e}. Check certificate configuration.")
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"Connection Error: {e}. Is the dashboard running?")
    except requests.exceptions.Timeout:
        raise RuntimeError(f"Request timed out after {timeout}s")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Request failed: {e}")


def api_get(config, path, timeout=10, stream=False):
    """
    Send a GET request to the dashboard API.
    
    Args:
        config: Agent configuration dictionary
        path: API endpoint path
        timeout: Request timeout in seconds
        stream: If True, stream the response
        
    Returns:
        requests.Response object
        
    Raises:
        RuntimeError: If request fails
    """
    url = f"{config['dashboardUrl'].rstrip('/')}{path}"
    
    headers = {
        "Authorization": f"Bearer {config['agentApiToken']}",
        "User-Agent": "AgentAutoUpdate/1.0"
    }
    
    # GET requests are not signed, but they still honor the local TLS policy.
    security_config = load_security_config()
    verify_ssl = security_config.get("verifyTls", True)
    if security_config.get("allowSelfSigned", False):
        verify_ssl = False
    
    try:
        response = requests.get(
            url,
            headers=headers,
            timeout=timeout,
            stream=stream,
            verify=verify_ssl
        )
        
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
        
        return response
        
    except requests.exceptions.SSLError as e:
        raise RuntimeError(f"SSL Error: {e}. Check certificate configuration.")
    except requests.exceptions.ConnectionError as e:
        raise RuntimeError(f"Connection Error: {e}. Is the dashboard running?")
    except requests.exceptions.Timeout:
        raise RuntimeError(f"Request timed out after {timeout}s")
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"Request failed: {e}")
