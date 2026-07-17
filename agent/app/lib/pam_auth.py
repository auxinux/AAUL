"""Authenticates local web interface logins against Linux system users:
PAM (python-pam) when available, falling back to the shadow file + crypt.
Also manages the resulting session tokens.
"""

import os
import secrets
import hashlib
import time
from typing import Optional, Tuple, Dict
from functools import wraps

from lib.logs import log


# Session storage: token -> {username, expires, created}
_sessions: Dict[str, dict] = {}

# Session timeout in seconds (1 hour by default)
SESSION_TIMEOUT = 3600

# Allowed groups for local web access (empty = any authenticated user)
# Can be configured to restrict access to specific groups like 'sudo', 'wheel', 'admin'
ALLOWED_GROUPS: list = []


class PAMAuth:
    """PAM-based authentication for Linux system users, falling back to shadow + crypt."""

    def __init__(self):
        self.pam_available = self._check_pam()
        self.shadow_available, self.shadow_backend = self._check_shadow()
        
        if self.pam_available:
            log("Authentification PAM disponible")
        if self.shadow_available:
            log(f"Authentification shadow disponible (backend: {self.shadow_backend})")
        if not self.pam_available and not self.shadow_available:
            log("AVERTISSEMENT: Aucune méthode d'authentification disponible!")
    
    def _check_pam(self) -> bool:
        """Check if PAM module is available."""
        try:
            import pam
            return True
        except ImportError:
            return False
    
    def _check_shadow(self) -> Tuple[bool, Optional[str]]:
        """Check if shadow auth backend is available (module-level only)."""
        try:
            import spwd  # noqa: F401
            log("Module spwd disponible")
        except ImportError:
            log("Module spwd non disponible")
            return False, None
        
        try:
            import crypt  # noqa: F401
            log("Module crypt disponible")
            return True, "crypt"
        except ImportError:
            log("Module crypt non disponible, essai passlib...")
        
        try:
            from passlib.context import CryptContext  # noqa: F401
            log("Module passlib disponible")
            return True, "passlib"
        except ImportError as e:
            log(f"Module passlib non disponible: {e}")
            return False, None
    
    def authenticate(self, username: str, password: str) -> Tuple[bool, str]:
        """Authenticate a Linux user. Returns (success, message)."""
        if not username or not password:
            return False, "Nom d'utilisateur et mot de passe requis"

        # Reject anything that isn't a plain username before it reaches PAM/shadow lookups.
        if not username.replace('_', '').replace('-', '').isalnum():
            return False, "Nom d'utilisateur invalide"

        if not self._user_exists(username):
            log(f"Tentative de connexion: utilisateur inexistant '{username}'")
            return False, "Authentification échouée"

        if ALLOWED_GROUPS and not self._user_in_groups(username, ALLOWED_GROUPS):
            log(f"Utilisateur '{username}' non autorisé (pas dans les groupes requis)")
            return False, "Utilisateur non autorisé"

        if self.pam_available:
            success, message = self._auth_pam(username, password)
            if success:
                return True, message

        if self.shadow_available:
            success, message = self._auth_shadow(username, password)
            if success:
                return True, message

        log(f"Échec authentification pour '{username}'")
        return False, "Authentification échouée"
    
    def _user_exists(self, username: str) -> bool:
        """Check if a user exists on the system."""
        try:
            import pwd
            pwd.getpwnam(username)
            return True
        except (KeyError, ImportError):
            return False
    
    def _user_in_groups(self, username: str, allowed_groups: list) -> bool:
        """Check if user is in any of the allowed groups."""
        try:
            import pwd
            import grp

            user_info = pwd.getpwnam(username)
            primary_gid = user_info.pw_gid
            primary_group = grp.getgrgid(primary_gid).gr_name

            if primary_group in allowed_groups:
                return True

            for group_name in allowed_groups:
                try:
                    group = grp.getgrnam(group_name)
                    if username in group.gr_mem:
                        return True
                except KeyError:
                    continue
            
            return False
        except (KeyError, ImportError):
            return False
    
    def _auth_pam(self, username: str, password: str) -> Tuple[bool, str]:
        """Authenticate using PAM."""
        try:
            import pam
            p = pam.pam()

            services = ["login", "system-auth", "sshd", "su"]
            for service in services:
                if p.authenticate(username, password, service=service):
                    log(f"Authentification PAM réussie pour '{username}' via {service}")
                    return True, "Authentification réussie"

            return False, p.reason or "Authentification échouée"
        except Exception as e:
            log(f"Erreur PAM: {e}")
            return False, str(e)
    
    def _auth_shadow(self, username: str, password: str) -> Tuple[bool, str]:
        """Authenticate using shadow file (requires root)."""
        try:
            import spwd

            shadow_entry = spwd.getspnam(username)
            stored_hash = shadow_entry.sp_pwdp

            if stored_hash.startswith('!') or stored_hash.startswith('*'):
                return False, "Compte désactivé"

            if self.shadow_backend == "crypt":
                import crypt
                computed_hash = crypt.crypt(password, stored_hash)
                if secrets.compare_digest(computed_hash, stored_hash):
                    log(f"Authentification shadow réussie pour '{username}'")
                    return True, "Authentification réussie"
                return False, "Mot de passe incorrect"

            if self.shadow_backend == "passlib":
                from passlib.context import CryptContext
                ctx = CryptContext(
                    schemes=["sha512_crypt", "sha256_crypt", "md5_crypt", "des_crypt"],
                    deprecated="auto"
                )
                if ctx.verify(password, stored_hash):
                    log(f"Authentification shadow réussie pour '{username}'")
                    return True, "Authentification réussie"
                return False, "Mot de passe incorrect"

            return False, "Aucun backend shadow disponible"
        except KeyError:
            return False, "Utilisateur non trouvé"
        except PermissionError:
            log("Permission refusée pour lire /etc/shadow (exécuter en root)")
            return False, "Erreur serveur"
        except Exception as e:
            log(f"Erreur shadow: {e}")
            return False, str(e)
    
    def get_user_info(self, username: str) -> Optional[dict]:
        """Get user information from the system."""
        try:
            import pwd
            user_info = pwd.getpwnam(username)
            return {
                "username": user_info.pw_name,
                "uid": user_info.pw_uid,
                "gid": user_info.pw_gid,
                "home": user_info.pw_dir,
                "shell": user_info.pw_shell,
                "gecos": user_info.pw_gecos  # Full name/description
            }
        except (KeyError, ImportError):
            return None


_pam_auth: Optional[PAMAuth] = None


def get_pam_auth() -> PAMAuth:
    """Get the singleton PAMAuth instance."""
    global _pam_auth
    if _pam_auth is None:
        _pam_auth = PAMAuth()
    return _pam_auth


def create_session(username: str) -> str:
    """Create a session for an authenticated user and return its token."""
    token = secrets.token_urlsafe(32)

    _sessions[token] = {
        "username": username,
        "created": time.time(),
        "expires": time.time() + SESSION_TIMEOUT,
        "last_access": time.time()
    }

    cleanup_sessions()

    log(f"Session créée pour '{username}'")
    return token


def validate_session(token: str) -> Optional[str]:
    """Return the session's username if the token is valid, else None. Slides the expiry forward."""
    if not token or token not in _sessions:
        return None

    session = _sessions[token]

    if time.time() > session["expires"]:
        del _sessions[token]
        return None

    session["last_access"] = time.time()
    session["expires"] = time.time() + SESSION_TIMEOUT

    return session["username"]


def destroy_session(token: str) -> bool:
    """Log out by destroying the session. Returns True if a session was destroyed."""
    if token in _sessions:
        username = _sessions[token]["username"]
        del _sessions[token]
        log(f"Session détruite pour '{username}'")
        return True
    return False


def cleanup_sessions():
    """Remove all expired sessions."""
    now = time.time()
    expired = [token for token, session in _sessions.items() 
               if now > session["expires"]]
    for token in expired:
        del _sessions[token]


def get_session_info(token: str) -> Optional[dict]:
    """Get information about a session."""
    if token not in _sessions:
        return None
    
    session = _sessions[token]
    return {
        "username": session["username"],
        "created": session["created"],
        "expires": session["expires"],
        "last_access": session["last_access"]
    }


def require_auth(handler):
    """Decorator requiring a valid session, from either a Bearer token or a session cookie."""
    @wraps(handler)
    def wrapper(request_handler, *args, **kwargs):
        token = None

        auth_header = request_handler.headers.get('Authorization', '')
        if auth_header.startswith('Bearer '):
            token = auth_header[7:]

        if not token:
            cookies = request_handler.headers.get('Cookie', '')
            for cookie in cookies.split(';'):
                cookie = cookie.strip()
                if cookie.startswith('session='):
                    token = cookie[8:]
                    break

        username = validate_session(token)
        if not username:
            request_handler.send_response(401)
            request_handler.send_header('Content-Type', 'application/json')
            request_handler.send_header('WWW-Authenticate', 'Bearer')
            request_handler.end_headers()
            request_handler.wfile.write(b'{"error": "Authentication required"}')
            return

        request_handler.authenticated_user = username

        return handler(request_handler, *args, **kwargs)

    return wrapper


def login(username: str, password: str) -> Tuple[bool, str, Optional[str]]:
    """Authenticate and, on success, create a session. Returns (success, message, token)."""
    auth = get_pam_auth()
    success, message = auth.authenticate(username, password)

    if success:
        token = create_session(username)
        return True, message, token

    return False, message, None


def logout(token: str) -> bool:
    """Destroy the session for a token. Returns True if it existed."""
    return destroy_session(token)
