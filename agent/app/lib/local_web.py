"""Optional local web interface for managing the agent directly, without
going through the dashboard. Enabled/disabled per-agent from the dashboard.

Authentication is PAM-based (Linux system users) with session tokens, TLS
is optional, and the required firewall port is opened/closed automatically.
"""

import json
import html as html_mod
import os
import platform
import ssl
import threading
import time
import base64
from collections import defaultdict
from functools import wraps
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from typing import Optional

# Rate limiting for login attempts
_login_attempts: dict = defaultdict(list)
# Reboot password attempts, throttled separately from logins.
_reboot_attempts = defaultdict(list)
_LOGIN_WINDOW_S = 900  # 15 minutes
_MAX_LOGIN_ATTEMPTS = 5

from .config import LOCAL_WEB_STATE_PATH, LOG_DIR, load_config, read_state, get_agent_version
from .system_info import collect_system_info, get_uptime_seconds, get_reboot_required
from .util import get_hostname, get_primary_ip
from .logs import log

# Try to import PAM auth module
try:
    from .pam_auth import login, logout, validate_session, get_session_info, get_pam_auth
except ImportError:
    login = None
    logout = None
    validate_session = None
    get_session_info = None
    get_pam_auth = None
    log("Module pam_auth non disponible")

# Try to import firewall module
try:
    from .firewall import get_firewall_manager, open_port, close_port, update_port
    FIREWALL_AVAILABLE = True
except ImportError:
    FIREWALL_AVAILABLE = False
    log("Module firewall non disponible")


# Default ports that can be used
ALLOWED_PORTS = [8080, 8090, 8180, 8190]

# State file for local web configuration
LOCAL_WEB_STATE_FILE = LOCAL_WEB_STATE_PATH


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    """HTTP Server that handles each request in a new thread."""
    daemon_threads = True
    allow_reuse_address = True


class AgentWebHandler(BaseHTTPRequestHandler):
    """HTTP request handler for the local web interface."""

    manager = None
    
    def log_message(self, format, *args):
        """Override to use our logging."""
        log(f"[LocalWeb] {format % args}")
    
    def _send_security_headers(self):
        """Send common security headers on all responses."""
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-XSS-Protection", "1; mode=block")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'")

    def send_json(self, data, status=200):
        """Send JSON response."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(json.dumps(data, indent=2).encode())

    def send_html(self, html, status=200):
        """Send HTML response."""
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self._send_security_headers()
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))
    
    def get_session_token(self) -> Optional[str]:
        """Extract session token from the Authorization header or session cookie."""
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            return auth_header[7:]

        cookies = self.headers.get("Cookie", "")
        for cookie in cookies.split(";"):
            cookie = cookie.strip()
            if cookie.startswith("session="):
                return cookie[8:]

        return None

    def check_auth(self) -> Optional[str]:
        """Return the authenticated username, or None if the request isn't authenticated."""
        token = self.get_session_token()
        if token and validate_session:
            username = validate_session(token)
            if username:
                return username
        
        return None
    
    def send_login_page(self, error: str = ""):
        """Send the login page."""
        error_html = f'<div class="error">{html_mod.escape(error)}</div>' if error else ""
        
        html = f"""<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Auto Update - Connexion</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
        }}
        .login-container {{
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        }}
        h1 {{
            text-align: center;
            margin-bottom: 8px;
            color: #10b981;
        }}
        .subtitle {{
            text-align: center;
            color: #9ca3af;
            margin-bottom: 32px;
            font-size: 14px;
        }}
        .form-group {{
            margin-bottom: 20px;
        }}
        label {{
            display: block;
            margin-bottom: 8px;
            color: #9ca3af;
            font-size: 14px;
        }}
        input {{
            width: 100%;
            padding: 12px 16px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
            font-size: 16px;
            transition: border-color 0.2s;
        }}
        input:focus {{
            outline: none;
            border-color: #10b981;
        }}
        button {{
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 8px;
            background: #10b981;
            color: white;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
        }}
        button:hover {{
            background: #059669;
        }}
        .error {{
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #f87171;
            padding: 12px;
            border-radius: 8px;
            margin-bottom: 20px;
            text-align: center;
        }}
        .info {{
            margin-top: 24px;
            padding: 16px;
            background: rgba(59, 130, 246, 0.1);
            border: 1px solid rgba(59, 130, 246, 0.3);
            border-radius: 8px;
            font-size: 13px;
            color: #93c5fd;
        }}
        .info-icon {{ margin-right: 8px; }}
    </style>
</head>
<body>
    <div class="login-container">
        <h1>🔐 Agent AutoUpdate</h1>
        <p class="subtitle">Interface de gestion locale</p>
        
        {error_html}
        
        <form method="POST" action="/login">
            <div class="form-group">
                <label for="username">Nom d'utilisateur Linux</label>
                <input type="text" id="username" name="username" required 
                       autocomplete="username" placeholder="Votre utilisateur système">
            </div>
            <div class="form-group">
                <label for="password">Mot de passe</label>
                <input type="password" id="password" name="password" required
                       autocomplete="current-password" placeholder="Votre mot de passe système">
            </div>
            <button type="submit">Se connecter</button>
        </form>
        
        <div class="info">
            <span class="info-icon">ℹ️</span>
            Utilisez vos identifiants de connexion Linux.
            Seuls les utilisateurs autorisés peuvent accéder à cette interface.
        </div>
    </div>
</body>
</html>"""
        self.send_html(html)
    
    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        
        # Public routes (no auth required)
        if path == "/login":
            error = parse_qs(parsed.query).get("error", [""])[0]
            self.send_login_page(error)
            return
        
        if path == "/health":
            self.send_json({"status": "ok"})
            return

        username = self.check_auth()
        if not username:
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
            return

        if path == "/" or path == "/index.html":
            self.serve_dashboard(username)
        elif path == "/api/status":
            self.api_status()
        elif path == "/api/info":
            self.api_info()
        elif path == "/api/logs":
            self.api_logs()
        elif path == "/api/firewall":
            self.api_firewall_status()
        elif path == "/api/packages":
            self.api_packages_list()
        elif path == "/logout":
            self.handle_logout()
        else:
            self.send_json({"error": "Not found"}, 404)
    
    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        path = parsed.path
        
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except (TypeError, ValueError):
            content_length = 0
        if content_length < 0:
            content_length = 0
        body = self.rfile.read(content_length).decode("utf-8", errors="replace") if content_length > 0 else ""
        
        if path == "/login":
            self.handle_login(body)
            return

        username = self.check_auth()
        if not username:
            self.send_json({"error": "Authentication required"}, 401)
            return

        try:
            data = json.loads(body) if body and body.startswith("{") else {}
        except json.JSONDecodeError:
            data = {}

        if not data and body:
            data = dict(parse_qs(body))
            data = {k: v[0] if len(v) == 1 else v for k, v in data.items()}
        
        if path == "/api/run-update":
            self.api_run_update()
        elif path == "/api/packages/search":
            self.api_packages_search(data)
        elif path == "/api/packages/install":
            self.api_package_action(data, "install")
        elif path == "/api/packages/remove":
            self.api_package_action(data, "remove")
        elif path == "/api/reboot":
            self.api_reboot(data, username)
        else:
            self.send_json({"error": "Not found"}, 404)
    
    def _get_client_ip(self) -> str:
        """Get client IP address."""
        return self.client_address[0] if self.client_address else "unknown"

    def _is_login_rate_limited(self, ip: str) -> bool:
        """Check if login is rate-limited for this IP."""
        now = time.time()
        _login_attempts[ip] = [t for t in _login_attempts[ip] if now - t < _LOGIN_WINDOW_S]
        return len(_login_attempts[ip]) >= _MAX_LOGIN_ATTEMPTS

    def handle_login(self, body: str):
        """Handle login form submission."""
        client_ip = self._get_client_ip()

        # Rate limiting
        if self._is_login_rate_limited(client_ip):
            self.send_response(302)
            self.send_header("Location", "/login?error=Trop+de+tentatives.+Reessayez+plus+tard.")
            self.end_headers()
            return

        # Parse form data
        from urllib.parse import parse_qs
        params = parse_qs(body)
        username = params.get("username", [""])[0]
        password = params.get("password", [""])[0]

        if not username or not password:
            self.send_response(302)
            self.send_header("Location", "/login?error=Identifiants+requis")
            self.end_headers()
            return

        if not login:
            log("Authentification non disponible (module pam_auth manquant)")
            self.send_response(302)
            self.send_header("Location", "/login?error=Authentification+non+disponible")
            self.end_headers()
            return

        # Authenticate with PAM/shadow
        success, message, token = login(username, password)
        
        if success and token:
            # Clear rate-limit on success
            _login_attempts.pop(client_ip, None)
            log(f"Connexion réussie pour {username}")
            self.send_response(302)
            # Set session cookie (HttpOnly, Secure if HTTPS)
            cookie = f"session={token}; Path=/; HttpOnly; SameSite=Strict"
            if isinstance(self.connection, ssl.SSLSocket):
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
            self.send_header("Location", "/")
            self.end_headers()
        else:
            _login_attempts[client_ip].append(time.time())
            log(f"Échec connexion pour {username}: {message}")
            self.send_response(302)
            self.send_header("Location", "/login?error=Identifiants+invalides")
            self.end_headers()
    
    def handle_logout(self):
        """Handle logout."""
        token = self.get_session_token()
        if token:
            logout(token)
        
        self.send_response(302)
        self.send_header("Set-Cookie", "session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        self.send_header("Location", "/login")
        self.end_headers()
    
    def serve_dashboard(self, username: str):
        """Serve the main dashboard HTML page."""
        config = load_config()
        state = read_state()

        # Get system info
        try:
            sys_info = collect_system_info()
        except:
            sys_info = {}

        hostname = get_hostname()
        ip_address = get_primary_ip()
        version = get_agent_version()

        # Format timestamps
        def format_timestamp(iso_str):
            if not iso_str or iso_str == "N/A":
                return "—"
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
                return dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
            except:
                return iso_str

        last_poll = format_timestamp(state.get("lastPoll"))
        last_update = format_timestamp(state.get("lastUpdate"))
        dashboard_url = config.get("dashboardUrl", "N/A")
        
        # Firewall status
        firewall_status = "Non disponible"
        if FIREWALL_AVAILABLE:
            fw = get_firewall_manager()
            fw_status = fw.get_status()
            firewall_status = f"{fw_status['firewall_type']} (actif)" if fw_status["active"] else "Aucun firewall actif"

        # OS info
        os_info = sys_info.get('os', {})
        if isinstance(os_info, dict):
            os_display = f"{os_info.get('name', '')} {os_info.get('version', '')}".strip() or "N/A"
        else:
            os_display = str(os_info)

        # Resources
        cpu = sys_info.get('cpu', {})
        memory = sys_info.get('memory', {})
        disks = [d for d in sys_info.get('disks', []) if d.get('totalBytes', 0) > 0]
        ips = sys_info.get('ips', [])
        gpus = sys_info.get('gpu', [])
        packages_count = sys_info.get('packagesInstalled', 0)
        reboot_required = get_reboot_required()

        def fmt_bytes(size):
            if not size:
                return "0 B"
            for unit, thr in [("TB", 1 << 40), ("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)]:
                if size >= thr:
                    return f"{size / thr:.1f} {unit}"
            return f"{size} B"

        # CPU values
        cpu_pct = cpu.get('usagePercent', 0)
        cpu_free = round(100 - cpu_pct, 1)
        cpu_model = html_mod.escape(cpu.get('model', 'N/A'))
        cpu_cores = cpu.get('cores', 0)
        cpu_threads = cpu.get('threads', 0)
        cpu_bar_cls = "danger" if cpu_pct >= 90 else ("warn" if cpu_pct >= 75 else "")

        # Memory values
        mem_total_b = memory.get('totalBytes', 0) or 1
        mem_used_b = memory.get('usedBytes', 0)
        mem_free_b = memory.get('availableBytes', 0)
        mem_pct = round(mem_used_b / mem_total_b * 100)
        mem_total = fmt_bytes(memory.get('totalBytes', 0))
        mem_used = fmt_bytes(mem_used_b)
        mem_free = fmt_bytes(mem_free_b)
        mem_bar_cls = "danger" if mem_pct >= 90 else ("warn" if mem_pct >= 75 else "")

        # Disk HTML (server-rendered, updated via JS polling)
        def disk_bar_cls(pct):
            return "danger" if pct >= 90 else ("warn" if pct >= 75 else "")

        disk_html_parts = []
        for disk in disks[:4]:
            dtotal = disk.get('totalBytes', 0) or 1
            dused = disk.get('usedBytes', 0)
            dfree = disk.get('availableBytes', 0)
            dpct = round(dused / dtotal * 100)
            dcls = disk_bar_cls(dpct)
            mp = html_mod.escape(disk.get('mountpoint', '/'))
            dev = html_mod.escape(disk.get('device', 'N/A'))
            disk_html_parts.append(f"""<div class="disk-item">
                <div class="disk-name">{mp}</div>
                <div class="disk-device">{dev} &bull; Total : {fmt_bytes(dtotal)}</div>
                <div class="res-hdr"><span class="res-lbl">Utilisé</span><span class="res-val">{fmt_bytes(dused)} ({dpct}%)</span></div>
                <div class="prog-track"><div class="prog-fill {dcls}" style="width:{dpct}%"></div></div>
                <div class="res-sub">Disponible : {fmt_bytes(dfree)}</div>
            </div>""")
        disk_html = "\n".join(disk_html_parts) or '<div style="color:#64748b;font-size:14px">Aucun disque détecté</div>'

        # IP section
        ip_section = ""
        if ips:
            chips = "".join(f'<div class="ip-chip">{html_mod.escape(str(ip))}</div>' for ip in ips[:8])
            ip_section = f'<div class="card"><div class="card-title">Interfaces réseau</div><div class="ip-list">{chips}</div></div>'

        # GPU section
        gpu_section = ""
        if gpus:
            items = "".join(f'<div class="list-item">{html_mod.escape(str(g))}</div>' for g in gpus)
            gpu_section = f'<div class="card"><div class="card-title">GPU</div><div class="list-stack">{items}</div></div>'

        # Reboot display
        reboot_val = "Oui ⚠️" if reboot_required else "Non ✓"
        reboot_style = "color:#f59e0b;font-weight:700" if reboot_required else "color:#10b981"
        reboot_pill_style = "" if reboot_required else "display:none"

        h_hostname = html_mod.escape(hostname)
        h_version = html_mod.escape(str(version))
        h_ip = html_mod.escape(str(ip_address))
        h_os = html_mod.escape(os_display)
        h_fw = html_mod.escape(firewall_status)
        h_dash = html_mod.escape(dashboard_url)
        h_user = html_mod.escape(username)

        html = (
            "<!DOCTYPE html>\n"
            '<html lang="fr">\n'
            "<head>\n"
            '<meta charset="UTF-8">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
            f"<title>Agent – {h_hostname}</title>\n"
            '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;600&display=swap">\n'
            "<style>\n"
            "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}\n"
            ":root{\n"
            "  --bg:#080c13;--surf:#0f1721;--bdr:rgba(255,255,255,0.06);\n"
            "  --brand:#0c81eb;--brandd:rgba(12,129,235,0.12);\n"
            "  --grn:#33f0b5;--grnd:rgba(51,240,181,0.08);\n"
            "  --txt:#e2e8f0;--mut:#4d6376;\n"
            "  --red:#ef4444;--amb:#f59e0b;\n"
            "  --font-sans:'Inter',-apple-system,sans-serif;\n"
            "  --font-display:'Space Grotesk',sans-serif;\n"
            "}\n"
            "body{\n"
            "  font-family:var(--font-sans);background:var(--bg);\n"
            "  background-image:radial-gradient(circle at 50% -20%, rgba(12,129,235,0.15), transparent 70%);\n"
            "  color:var(--txt);min-height:100vh;padding-bottom:40px;line-height:1.5;\n"
            "}\n"
            ".hdr{\n"
            "  background:rgba(15,23,33,0.7);backdrop-filter:blur(12px);border-bottom:1px solid var(--bdr);\n"
            "  padding:0 24px;height:64px;display:flex;align-items:center;justify-content:space-between;\n"
            "  position:sticky;top:0;z-index:50;\n"
            "}\n"
            ".hdr-l{display:flex;align-items:center;gap:12px}\n"
            ".logo{font-family:var(--font-display);font-size:18px;font-weight:700;color:#fff;display:flex;align-items:center;gap:8px}\n"
            ".logo span{color:var(--brand)}\n"
            ".host-chip{font-size:13px;color:var(--txt);background:rgba(255,255,255,0.05);border:1px solid var(--bdr);padding:4px 10px;border-radius:8px;font-family:monospace}\n"
            ".hdr-r{display:flex;align-items:center;gap:16px}\n"
            ".ver-chip{font-size:11px;font-weight:700;color:var(--brand);background:var(--brandd);border:1px solid rgba(12,129,235,0.2);padding:3px 8px;border-radius:6px;font-family:monospace}\n"
            ".usr-chip{font-size:13px;color:var(--mut);display:flex;align-items:center;gap:6px}\n"
            ".logout{\n"
            "  font-size:13px;font-weight:600;color:var(--red);text-decoration:none;padding:6px 14px;\n"
            "  border:1px solid rgba(239,68,68,0.2);background:rgba(239,68,68,0.05);border-radius:8px;\n"
            "  transition:all .2s;display:inline-flex;align-items:center;gap:6px;\n"
            "}\n"
            ".logout:hover{background:rgba(239,68,68,0.15);border-color:var(--red);transform:translateY(-0.5px)}\n"
            ".sbar{\n"
            "  background:rgba(15,23,33,0.4);backdrop-filter:blur(8px);border-bottom:1px solid var(--bdr);\n"
            "  padding:10px 24px;display:flex;align-items:center;gap:24px;font-size:13px;color:var(--mut);flex-wrap:wrap;\n"
            "}\n"
            ".dot{width:8px;height:8px;border-radius:50%;background:var(--grn);flex-shrink:0;box-shadow:0 0 8px var(--grn);animation:pulse 2s infinite}\n"
            "@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(0.95)}}\n"
            ".sbar-item{display:flex;align-items:center;gap:6px}\n"
            ".sbar-item strong{color:var(--txt)}\n"
            ".reboot-pill{\n"
            "  margin-left:auto;color:var(--red);background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);\n"
            "  padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;\n"
            "}\n"
            ".tabs{display:flex;padding:0 24px;border-bottom:1px solid var(--bdr);overflow-x:auto;gap:8px;background:rgba(8,12,19,0.3)}\n"
            ".tab{\n"
            "  padding:16px 12px;background:none;border:none;color:var(--mut);cursor:pointer;font-size:14px;font-weight:600;\n"
            "  border-bottom:2px solid transparent;transition:all .2s;white-space:nowrap;display:flex;align-items:center;gap:8px;\n"
            "}\n"
            ".tab:hover{color:var(--txt)}\n"
            ".tab.active{color:var(--brand);border-bottom-color:var(--brand)}\n"
            ".wrap{padding:24px;max-width:1000px;margin:0 auto}\n"
            ".pane{display:none;animation:fadeIn 0.3s ease-out}.pane.active{display:block}\n"
            "@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}\n"
            ".card{background:var(--surf);border:1px solid var(--bdr);border-radius:16px;padding:24px;margin-bottom:24px;box-shadow:0 4px 20px rgba(0,0,0,0.15)}\n"
            ".card-title{\n"
            "  font-family:var(--font-display);font-size:11px;text-transform:uppercase;letter-spacing:.15em;\n"
            "  color:var(--mut);margin-bottom:20px;font-weight:700;display:flex;align-items:center;justify-content:between;\n"
            "}\n"
            ".igrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px}\n"
            ".icell{background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,0.02);padding:16px;border-radius:12px;transition:border-color 0.2s}\n"
            ".icell:hover{border-color:var(--bdr)}\n"
            ".ilbl{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px;font-weight:600}\n"
            ".ival{font-size:14px;font-weight:600;color:#fff;overflow-wrap:break-word}\n"
            ".two-col{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px;margin-bottom:24px}\n"
            ".res-item{margin-bottom:18px}.res-item:last-child{margin-bottom:0}\n"
            ".res-hdr{display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px}\n"
            ".res-lbl{color:var(--mut);font-weight:500}.res-val{font-weight:600;color:#fff}\n"
            ".prog-track{height:8px;background:rgba(255,255,255,.05);border-radius:4px;overflow:hidden}\n"
            ".prog-fill{height:100%;border-radius:4px;background:var(--brand);transition:width .5s ease}\n"
            ".prog-fill.warn{background:var(--amb)}.prog-fill.danger{background:var(--red)}\n"
            ".res-sub{font-size:12px;color:var(--mut);margin-top:6px;font-weight:500}\n"
            ".disk-item{margin-bottom:24px}.disk-item:last-child{margin-bottom:0}\n"
            ".disk-name{font-size:15px;font-weight:700;color:#fff;margin-bottom:2px}\n"
            ".disk-device{font-size:12px;color:var(--mut);margin-bottom:10px;font-family:monospace}\n"
            ".log-box{\n"
            "  background:#05070c;border:1px solid var(--bdr);border-radius:12px;padding:16px 20px;\n"
            "  font-family:'JetBrains Mono','Courier New',monospace;font-size:12px;height:480px;\n"
            "  overflow-y:auto;line-height:1.7;color:#a3b1bd;box-shadow:inset 0 2px 8px rgba(0,0,0,0.5);\n"
            "}\n"
            ".log-line{margin:0;border-bottom:1px solid rgba(255,255,255,0.01);padding:2px 0}\n"
            ".log-line.err{color:#f87171;background:rgba(239,68,68,0.05)}.log-line.wrn{color:#fbbf24;background:rgba(245,158,11,0.03)}\n"
            ".log-ctrl{display:flex;gap:12px;margin-bottom:16px;align-items:center;flex-wrap:wrap}\n"
            ".btn{\n"
            "  padding:10px 20px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;\n"
            "  transition:all .2s;display:inline-flex;align-items:center;justify-content:center;gap:8px;\n"
            "}\n"
            ".btn-p{background:var(--brand);color:#fff;box-shadow:0 4px 12px rgba(12,129,235,0.25)}\n"
            ".btn-p:hover{background:#1a8df5;transform:translateY(-1px)}\n"
            ".btn-p:active{transform:translateY(0)}\n"
            ".btn-p:disabled{opacity:.5;cursor:not-allowed;transform:none}\n"
            ".btn-g{background:rgba(255,255,255,.05);color:var(--txt);border:1px solid var(--bdr)}\n"
            ".btn-g:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,0.1)}\n"
            ".btn-g.active{background:var(--brandd);color:var(--brand);border-color:rgba(12,129,235,0.3)}\n"
            ".btn-sm{padding:6px 14px;font-size:13px;border-radius:8px}\n"
            ".mo{position:fixed;inset:0;background:rgba(8,12,19,.85);display:flex;align-items:center;justify-content:center;z-index:200;backdrop-filter:blur(6px)}\n"
            ".mo-box{background:var(--surf);border:1px solid rgba(255,255,255,.1);border-radius:20px;padding:32px;max-width:560px;width:92%;box-shadow:0 20px 40px rgba(0,0,0,0.5)}\n"
            ".mo-title{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--brand);margin-bottom:16px}\n"
            ".mo-msg{font-size:14px;color:var(--txt);line-height:1.6;margin-bottom:20px}\n"
            ".mo-sub{font-size:13px;color:var(--mut);line-height:1.5;margin-top:8px}\n"
            ".mo-actions{display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap}\n"
            ".mo-actions .btn{min-width:120px}\n"
            ".mo-field{margin-bottom:20px}\n"
            ".mo-field label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);font-weight:700;margin-bottom:6px}\n"
            ".mo-field input{width:100%;padding:11px 14px;border-radius:10px;border:1px solid var(--bdr);background:rgba(0,0,0,.35);color:#fff;font-size:14px}\n"
            ".mo-field input:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(12,129,235,.15)}\n"
            ".mo-err{color:#f87171;font-size:13px;margin-bottom:14px;min-height:18px}\n"
            ".btn-d{background:var(--red);color:#fff;box-shadow:0 4px 12px rgba(239,68,68,.25)}\n"
            ".btn-d:hover{background:#dc2626;transform:translateY(-1px)}\n"
            ".btn-d:disabled{opacity:.5;cursor:not-allowed;transform:none}\n"
            ".mo-log{\n"
            "  background:#05070c;border-radius:10px;padding:16px;font-family:monospace;font-size:12px;height:240px;\n"
            "  overflow-y:auto;color:#a3b1bd;margin-bottom:20px;line-height:1.6;border:1px solid var(--bdr);\n"
            "}\n"
            ".ip-list{display:flex;flex-wrap:wrap;gap:8px}\n"
            ".ip-chip{background:rgba(0,0,0,.3);border:1px solid var(--bdr);padding:6px 12px;border-radius:8px;font-family:monospace;font-size:13px;color:#fff}\n"
            ".list-stack{display:flex;flex-direction:column;gap:8px}\n"
            ".list-item{background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,0.01);padding:12px 16px;border-radius:10px;font-size:13px;color:#fff}\n"
            ".act-row{display:flex;align-items:center;justify-content:space-between;padding:20px;background:rgba(0,0,0,.2);border:1px solid rgba(255,255,255,0.02);border-radius:12px;gap:20px;flex-wrap:wrap}\n"
            ".act-info{min-width:200px;flex:1}\n"
            ".act-info h3{font-size:15px;font-weight:700;color:#fff;margin-bottom:4px}\n"
            ".act-info p{font-size:13px;color:var(--mut);line-height:1.4}\n"
            "@media (max-width:768px){\n"
            "  .hdr{height:auto;padding:16px;flex-direction:column;gap:12px;align-items:stretch}\n"
            "  .hdr-r{justify-content:space-between}\n"
            "  .sbar{padding:12px 16px;gap:12px;font-size:12px}\n"
            "  .reboot-pill{margin-left:0;width:100%;text-align:center}\n"
            "  .wrap{padding:16px}\n"
            "  .card{padding:16px}\n"
            "  .act-row{flex-direction:column;align-items:stretch;gap:14px}\n"
            "  .act-row button{width:100%}\n"
            "}\n"
            "</style>\n"
            "</head>\n"
            "<body>\n"
            '<header class="hdr">\n'
            f'  <div class="hdr-l"><span class="logo">⚙ Agent AutoUpdate</span><span class="host-chip">{h_hostname}</span></div>\n'
            f'  <div class="hdr-r"><span class="ver-chip" id="hdr-ver">v{h_version}</span><span class="usr-chip">👤 {h_user}</span><a href="/logout" class="logout">Déconnexion</a></div>\n'
            "</header>\n"
            '<div class="sbar">\n'
            '  <div class="sbar-item"><div class="dot"></div><span>En ligne</span></div>\n'
            f'  <div class="sbar-item">Poll : <strong id="sb-poll">{last_poll}</strong></div>\n'
            f'  <div class="sbar-item">MàJ : <strong id="sb-upd">{last_update}</strong></div>\n'
            f'  <div class="reboot-pill" id="sb-reboot" style="{reboot_pill_style}">⚠️ Redémarrage requis</div>\n'
            "</div>\n"
            '<nav class="tabs">\n'
            '  <button class="tab active" onclick="showTab(\'ov\',this)">📊 Aperçu</button>\n'
            '  <button class="tab" onclick="showTab(\'res\',this)">💻 Ressources</button>\n'
            '  <button class="tab" onclick="showTab(\'logs\',this)">📋 Journaux</button>\n'
            '  <button class="tab" onclick="showTab(\'pkg\',this)">📦 Paquets</button>\n'
            '  <button class="tab" onclick="showTab(\'act\',this)">⚡ Actions</button>\n'
            "</nav>\n"
            '<div class="wrap">\n'
                # ── Aperçu ──
            '<div id="pane-ov" class="pane active">\n'
            # View toggle
            '<div class="log-ctrl" style="margin-bottom:20px;justify-content:flex-end">\n'
            '<span style="font-size:13px;color:var(--mut);margin-right:auto;align-self:center">Mode d\'affichage :</span>\n'
            '<button class="btn btn-g btn-sm active" id="btn-v-simple" onclick="toggleLocalView(\'simple\')">Simple</button>\n'
            '<button class="btn btn-g btn-sm" id="btn-v-detailed" onclick="toggleLocalView(\'detailed\')">Détaillé</button>\n'
            '</div>\n'
            
            # Simple Summary Card
            '<div class="card view-simple-only" style="margin-bottom:24px">\n'
            '  <div class="card-title">Statut Général</div>\n'
            '  <div class="act-row" style="background:rgba(51,240,181,0.04);border-color:rgba(51,240,181,0.1)">\n'
            '    <div class="act-info">\n'
            f'      <h3 style="display:flex;align-items:center;gap:8px;color:#fff"><span class="dot"></span> Agent Actif</h3>\n'
            f'      <p>La machine {h_hostname} est connectée au Dashboard et fonctionne normalement.</p>\n'
            '    </div>\n'
            f'    <button class="btn btn-p" onclick="runUpdate()" style="flex-shrink:0">🔄 Mettre à jour</button>\n'
            '  </div>\n'
            '</div>\n'

            '<div class="card"><div class="card-title">Informations système</div><div class="igrid">\n'
            f'<div class="icell"><div class="ilbl">Hostname</div><div class="ival">{h_hostname}</div></div>\n'
            f'<div class="icell"><div class="ilbl">Adresse IP</div><div class="ival">{h_ip}</div></div>\n'
            f'<div class="icell"><div class="ilbl">OS</div><div class="ival" style="font-size:13px">{h_os}</div></div>\n'
            f'<div class="icell"><div class="ilbl">Version Agent</div><div class="ival" id="ov-ver">{h_version}</div></div>\n'
            f'<div class="icell view-detailed-only"><div class="ilbl">Firewall</div><div class="ival" style="font-size:13px">{h_fw}</div></div>\n'
            f'<div class="icell view-detailed-only"><div class="ilbl">Packages installés</div><div class="ival">{packages_count}</div></div>\n'
            "</div></div>\n"
 
            '<div class="card"><div class="card-title">État des mises à jour</div><div class="igrid">\n'
            f'<div class="icell view-detailed-only" style="grid-column:span 2"><div class="ilbl">Serveur Dashboard</div><div class="ival" style="font-size:13px;font-family:monospace">{h_dash}</div></div>\n'
            f'<div class="icell"><div class="ilbl">Dernier poll</div><div class="ival" style="font-size:13px" id="ov-poll">{last_poll}</div></div>\n'
            f'<div class="icell"><div class="ilbl">Dernière MàJ</div><div class="ival" style="font-size:13px" id="ov-upd">{last_update}</div></div>\n'
            f'<div class="icell"><div class="ilbl">Redémarrage requis</div><div class="ival" id="ov-reboot" style="{reboot_style}">{reboot_val}</div></div>\n'
            "</div></div>\n"
            f'<div class="view-detailed-only">{ip_section}</div>\n<div class="view-detailed-only">{gpu_section}</div>\n'
            "</div>\n"  # end pane-ov

            # ── Ressources ──
            '<div id="pane-res" class="pane">\n'
            '<div class="two-col">\n'
            '<div class="card"><div class="card-title">CPU</div>\n'
            f'<div style="font-size:13px;margin-bottom:4px;overflow-wrap:break-word">{cpu_model}</div>\n'
            f'<div style="font-size:12px;color:var(--mut);margin-bottom:16px">{cpu_cores} cœurs / {cpu_threads} threads</div>\n'
            '<div class="res-item">\n'
            f'<div class="res-hdr"><span class="res-lbl">Utilisation</span><span class="res-val" id="cpu-pct">{cpu_pct}%</span></div>\n'
            f'<div class="prog-track"><div class="prog-fill {cpu_bar_cls}" id="cpu-bar" style="width:{cpu_pct}%"></div></div>\n'
            f'<div class="res-sub" id="cpu-free">{cpu_free}% disponible</div>\n'
            "</div></div>\n"
            '<div class="card"><div class="card-title">Mémoire</div>\n'
            f'<div style="font-size:13px;margin-bottom:16px">Total : <strong>{mem_total}</strong></div>\n'
            '<div class="res-item">\n'
            f'<div class="res-hdr"><span class="res-lbl">Utilisé</span><span class="res-val" id="mem-used">{mem_used}</span></div>\n'
            f'<div class="prog-track"><div class="prog-fill {mem_bar_cls}" id="mem-bar" style="width:{mem_pct}%"></div></div>\n'
            f'<div class="res-sub" id="mem-free">Disponible : {mem_free}</div>\n'
            "</div></div>\n"
            "</div>\n"  # two-col
            '<div class="card"><div class="card-title">Stockage</div>\n'
            f'<div id="disk-list">{disk_html}</div>\n'
            "</div>\n"
            "</div>\n"  # end pane-res

            # ── Journaux ──
            '<div id="pane-logs" class="pane">\n'
            '<div class="card"><div class="card-title">Journaux de l\'agent</div>\n'
            '<div class="log-ctrl">\n'
            '<button class="btn btn-g btn-sm" onclick="loadLogs()">🔄 Rafraîchir</button>\n'
            '<button class="btn btn-g btn-sm" onclick="scrollBottom()">⬇ Fin</button>\n'
            '<label style="font-size:13px;color:var(--mut);display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:4px">'
            '<input type="checkbox" id="auto-sc" checked> Auto-défilement</label>\n'
            '<span id="log-cnt" style="font-size:12px;color:var(--mut);margin-left:auto"></span>\n'
            "</div>\n"
            '<div class="log-box" id="log-box"><div class="log-line" style="color:var(--mut)">Chargement...</div></div>\n'
            "</div></div>\n"  # end pane-logs

            # ── Actions ──
            '<div id="pane-act" class="pane">\n'
            '<div class="card"><div class="card-title">Actions disponibles</div>\n'
            '<div class="act-row"><div class="act-info">'
            '<h3>Lancer une mise à jour système</h3>'
            '<p>Exécute apt/yum pour mettre à jour les packages installés.</p>'
            '</div>'
            '<button class="btn btn-p" onclick="runUpdate()" style="flex-shrink:0">🔄 Mettre à jour</button>'
            "</div>\n"
            '<div class="act-row" style="margin-top:12px;border-color:rgba(239,68,68,0.15);background:rgba(239,68,68,0.04)">'
            '<div class="act-info">'
            '<h3>Redémarrer la machine</h3>'
            "<p>Demande une confirmation et le mot de passe d'un compte administrateur "
            "de cette machine. Le redémarrage a lieu une minute plus tard.</p>"
            '</div>'
            '<button class="btn btn-d" onclick="rebootMachine()" style="flex-shrink:0">⏻ Redémarrer</button>'
            "</div></div></div>\n"  # end pane-act

            # ── Paquets ──
            '<div id="pane-pkg" class="pane">\n'
            '<div class="card">\n'
            '<div class="log-ctrl">\n'
            '<button class="tab active" id="pk-tab-inst" onclick="pkTab(\'inst\')" style="padding:8px 14px">Installés</button>\n'
            '<button class="tab" id="pk-tab-search" onclick="pkTab(\'search\')" style="padding:8px 14px">Rechercher &amp; installer</button>\n'
            "</div>\n"
            # Installed sub-pane
            '<div id="pk-pane-inst">\n'
            '<div class="log-ctrl">\n'
            '<button class="btn btn-g btn-sm" onclick="pkLoad()">🔄 Charger la liste</button>\n'
            '<input id="pk-filter" placeholder="Filtrer…" oninput="pkRender()" '
            'style="flex:1;min-width:160px;padding:8px 12px;border-radius:8px;border:1px solid var(--bdr);background:rgba(0,0,0,.3);color:#fff">\n'
            '<span id="pk-count" style="font-size:12px;color:var(--mut)"></span>\n'
            "</div>\n"
            '<div id="pk-list" style="max-height:430px;overflow-y:auto"></div>\n'
            "</div>\n"
            # Search sub-pane
            '<div id="pk-pane-search" style="display:none">\n'
            '<div class="log-ctrl">\n'
            '<input id="pk-query" placeholder="Nom du paquet…" onkeydown="if(event.key===\'Enter\')pkSearch()" '
            'style="flex:1;min-width:160px;padding:8px 12px;border-radius:8px;border:1px solid var(--bdr);background:rgba(0,0,0,.3);color:#fff">\n'
            '<button class="btn btn-p btn-sm" onclick="pkSearch()">🔍 Rechercher</button>\n'
            "</div>\n"
            '<div id="pk-results" style="max-height:430px;overflow-y:auto"></div>\n'
            "</div>\n"
            '<pre id="pk-output" style="display:none;margin-top:12px;background:#070d17;border-radius:8px;padding:12px;'
            'font-size:12px;color:#7a8fa8;max-height:200px;overflow:auto;white-space:pre-wrap"></pre>\n'
            "</div></div>\n"  # end pane-pkg

            "</div>\n"  # end wrap

            "<script>\n"

            # ---------------------------------------------------------------
            #  In-page dialogs
            # ---------------------------------------------------------------
            # Native confirm()/alert() are blocking, unstyled, positioned by the
            # browser and — in some embedded webviews — suppressed entirely, so a
            # destructive action could silently proceed or silently fail. Every
            # confirmation goes through uiConfirm() instead: a real element in the
            # page, keyboard accessible, that resolves to true/false.
            "function uiConfirm(opts){\n"
            "  return new Promise(function(resolve){\n"
            "    var o=document.createElement('div');o.className='mo';\n"
            "    var needPwd=!!opts.password;\n"
            "    var box=document.createElement('div');box.className='mo-box';\n"
            "    box.setAttribute('role','dialog');box.setAttribute('aria-modal','true');\n"
            "    var h=document.createElement('div');h.className='mo-title';h.textContent=opts.title||'Confirmer';\n"
            "    var m=document.createElement('div');m.className='mo-msg';m.textContent=opts.message||'';\n"
            "    box.appendChild(h);box.appendChild(m);\n"
            "    var input=null,err=null;\n"
            "    if(needPwd){\n"
            "      var f=document.createElement('div');f.className='mo-field';\n"
            "      var lb=document.createElement('label');lb.textContent=opts.passwordLabel||'Mot de passe';\n"
            "      lb.setAttribute('for','ui-pwd');\n"
            "      input=document.createElement('input');input.type='password';input.id='ui-pwd';\n"
            "      input.autocomplete='current-password';\n"
            "      f.appendChild(lb);f.appendChild(input);box.appendChild(f);\n"
            "      err=document.createElement('div');err.className='mo-err';box.appendChild(err);\n"
            "    }\n"
            "    var acts=document.createElement('div');acts.className='mo-actions';\n"
            "    var cancel=document.createElement('button');cancel.className='btn btn-g';\n"
            "    cancel.textContent=opts.cancelLabel||'Annuler';\n"
            "    var ok=document.createElement('button');\n"
            "    ok.className='btn '+(opts.danger?'btn-d':'btn-p');\n"
            "    ok.textContent=opts.confirmLabel||'Confirmer';\n"
            "    acts.appendChild(cancel);acts.appendChild(ok);box.appendChild(acts);\n"
            "    o.appendChild(box);document.body.appendChild(o);\n"
            "    var prev=document.activeElement;\n"
            "    function close(result){\n"
            "      document.removeEventListener('keydown',onKey);\n"
            "      if(o.parentNode)o.parentNode.removeChild(o);\n"
            "      if(prev&&prev.focus)prev.focus();\n"
            "      resolve(result);\n"
            "    }\n"
            "    function submit(){\n"
            "      if(needPwd){\n"
            "        var v=input.value;\n"
            "        if(!v){err.textContent='Mot de passe requis.';input.focus();return;}\n"
            "        close({password:v,username:opts.username||null});\n"
            "      }else{close(true);}\n"
            "    }\n"
            "    function onKey(e){\n"
            "      if(e.key==='Escape'){e.preventDefault();close(needPwd?null:false);}\n"
            "      else if(e.key==='Enter'&&needPwd){e.preventDefault();submit();}\n"
            "    }\n"
            "    cancel.onclick=function(){close(needPwd?null:false);};\n"
            "    ok.onclick=submit;\n"
            "    o.onclick=function(e){if(e.target===o)close(needPwd?null:false);};\n"
            "    document.addEventListener('keydown',onKey);\n"
            "    (input||ok).focus();\n"
            "  });\n"
            "}\n"
            "function uiAlert(title,message,danger){\n"
            "  return uiConfirm({title:title,message:message,confirmLabel:'Fermer',\n"
            "                    cancelLabel:null,danger:!!danger}).then(function(){});\n"
            "}\n"

            "async function rebootMachine(){\n"
            "  var creds=await uiConfirm({\n"
            "    title:'⏻ Redémarrer cette machine ?',\n"
            "    message:'Toutes les sessions et services en cours seront interrompus. "
            "Saisissez le mot de passe d\\'un compte administrateur de cette machine "
            "(root ou membre du groupe sudo) pour confirmer.',\n"
            "    password:true,passwordLabel:'Mot de passe administrateur',\n"
            "    confirmLabel:'Redémarrer',danger:true});\n"
            "  if(!creds)return;\n"
            "  var body={password:creds.password};\n"
            "  if(creds.username)body.username=creds.username;\n"
            "  try{\n"
            "    var r=await fetch('/api/reboot',{method:'POST',\n"
            "      headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});\n"
            "    var d=await r.json();\n"
            "    body.password=null;\n"
            "    if(r.ok&&d.success){\n"
            "      await uiAlert('Redémarrage planifié',d.message||'La machine va redémarrer.');\n"
            "    }else{\n"
            "      await uiAlert('Redémarrage refusé',d.error||'Échec de la demande.',true);\n"
            "    }\n"
            "  }catch(e){await uiAlert('Erreur réseau',String(e&&e.message||e),true);}\n"
            "}\n"

            "function showTab(id,el){\n"
            "  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('active'));\n"
            "  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));\n"
            "  document.getElementById('pane-'+id).classList.add('active');\n"
            "  el.classList.add('active');\n"
            "  if(id==='logs')loadLogs();\n"
            "  if(id==='pkg'&&!window._pkLoaded){window._pkLoaded=1;pkLoad();}\n"
            "}\n"

            "function fmtB(b){\n"
            "  if(!b)return'0 B';\n"
            "  if(b>=1099511627776)return(b/1099511627776).toFixed(1)+' TB';\n"
            "  if(b>=1073741824)return(b/1073741824).toFixed(1)+' GB';\n"
            "  if(b>=1048576)return(b/1048576).toFixed(1)+' MB';\n"
            "  if(b>=1024)return(b/1024).toFixed(1)+' KB';\n"
            "  return b+' B';\n"
            "}\n"
            "function barCls(p){return p>=90?'danger':p>=75?'warn':''}\n"
            "function setBar(id,pct){\n"
            "  const el=document.getElementById(id);\n"
            "  if(!el)return;\n"
            "  el.style.width=pct+'%';\n"
            "  el.className='prog-fill '+barCls(pct);\n"
            "}\n"
            "function setText(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}\n"

            "async function refresh(){\n"
            "  try{\n"
            "    const d=await fetch('/api/status').then(r=>r.json());\n"
            "    const poll=d.lastPoll||'—',upd=d.lastUpdate||'—';\n"
            "    ['sb-poll','ov-poll'].forEach(i=>setText(i,poll));\n"
            "    ['sb-upd','ov-upd'].forEach(i=>setText(i,upd));\n"
            "    const rb=document.getElementById('sb-reboot');\n"
            "    const ovRb=document.getElementById('ov-reboot');\n"
            "    if(rb)rb.style.display=d.rebootRequired?'':'none';\n"
            "    if(ovRb){ovRb.textContent=d.rebootRequired?'Oui ⚠️':'Non ✓';ovRb.style.color=d.rebootRequired?'#f59e0b':'#10b981';}\n"
            "    if(d.version){const v='v'+d.version;setText('hdr-ver',v);setText('ov-ver',d.version);}\n"
            "    const cpu=d.cpu||{};\n"
            "    const cp=cpu.usagePercent||0;\n"
            "    setText('cpu-pct',cp+'%');\n"
            "    setBar('cpu-bar',cp);\n"
            "    setText('cpu-free',(100-cp).toFixed(1)+'% disponible');\n"
            "    const mem=d.memory||{};\n"
            "    const mt=mem.totalBytes||1,mu=mem.usedBytes||0,mf=mem.availableBytes||0;\n"
            "    const mp=Math.round(mu/mt*100);\n"
            "    setText('mem-used',fmtB(mu));\n"
            "    setBar('mem-bar',mp);\n"
            "    setText('mem-free','Disponible : '+fmtB(mf));\n"
            "  }catch(e){console.warn('refresh err',e);}\n"
            "}\n"
            "setInterval(refresh,5000);\n"
            "refresh();\n"

            "async function loadLogs(){\n"
            "  const box=document.getElementById('log-box');\n"
            "  const cnt=document.getElementById('log-cnt');\n"
            "  try{\n"
            "    const d=await fetch('/api/logs').then(r=>r.json());\n"
            "    const lines=d.logs||[];\n"
            "    if(cnt)cnt.textContent=lines.length+' lignes';\n"
            "    box.innerHTML=lines.map(l=>{\n"
            "      const e=l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n"
            "      const c=/error|erreur|failed/i.test(l)?'err':/warn/i.test(l)?'wrn':'';\n"
            "      return '<div class=\"log-line '+c+'\">'+e+'</div>';\n"
            "    }).join('');\n"
            "    if(document.getElementById('auto-sc')?.checked)scrollBottom();\n"
            "  }catch(e){box.innerHTML='<div class=\"log-line err\">Erreur de chargement.</div>';}\n"
            "}\n"
            "function scrollBottom(){const b=document.getElementById('log-box');if(b)b.scrollTop=b.scrollHeight;}\n"
            "setInterval(()=>{const p=document.getElementById('pane-logs');if(p&&p.classList.contains('active'))loadLogs();},10000);\n"

            "async function runUpdate(){\n"
            "  if(!await uiConfirm({title:'Mise à jour système',\n"
            "    message:'Lancer maintenant la mise à jour des paquets de cette machine ?',\n"
            "    confirmLabel:'Lancer'}))return;\n"
            "  const ov=document.createElement('div');\n"
            "  ov.className='mo';\n"
            "  ov.innerHTML='<div class=\"mo-box\"><div class=\"mo-title\">⚙️ Mise à jour en cours...</div>'"
            "+'<div class=\"mo-log\" id=\"mu-log\">Démarrage...<br></div>'"
            "+'<button id=\"mu-btn\" class=\"btn btn-g\" style=\"width:100%\" disabled>En cours...</button></div>';\n"
            "  document.body.appendChild(ov);\n"
            "  const logEl=document.getElementById('mu-log');\n"
            "  const btn=document.getElementById('mu-btn');\n"
            "  function addLog(msg,col){\n"
            "    const sp=document.createElement('span');\n"
            "    if(col)sp.style.color=col;\n"
            "    sp.textContent=msg;\n"
            "    logEl.appendChild(sp);\n"
            "    logEl.appendChild(document.createElement('br'));\n"
            "    logEl.scrollTop=logEl.scrollHeight;\n"
            "  }\n"
            "  try{\n"
            "    const r=await fetch('/api/run-update',{method:'POST'});\n"
            "    const d=await r.json();\n"
            "    if(d.success){\n"
            "      addLog('✓ Mise à jour terminée !','#10b981');\n"
            "      if(d.message)addLog(d.message,'#94a3b8');\n"
            "      btn.disabled=false;btn.textContent='Fermer et rafraîchir';\n"
            "      btn.className='btn btn-p';btn.style.width='100%';\n"
            "      btn.onclick=()=>location.reload();\n"
            "    }else{\n"
            "      addLog('✗ Erreur : '+(d.error||'Échec'),'#f87171');\n"
            "      btn.disabled=false;btn.textContent='Fermer';\n"
            "      btn.onclick=()=>ov.remove();\n"
            "    }\n"
            "  }catch(e){\n"
            "    addLog('✗ Erreur réseau : '+e.message,'#f87171');\n"
            "    btn.disabled=false;btn.textContent='Fermer';\n"
            "    btn.onclick=()=>ov.remove();\n"
            "  }\n"
            "}\n"

            # ── Packages (JS) ──
            "var _pkInstalled=[];var _pkEnabled=false;\n"
            "function pkEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}\n"
            "function pkTab(which){\n"
            "  document.getElementById('pk-pane-inst').style.display=which==='inst'?'':'none';\n"
            "  document.getElementById('pk-pane-search').style.display=which==='search'?'':'none';\n"
            "  document.getElementById('pk-tab-inst').classList.toggle('active',which==='inst');\n"
            "  document.getElementById('pk-tab-search').classList.toggle('active',which==='search');\n"
            "}\n"
            "function pkOut(msg){var e=document.getElementById('pk-output');if(!e)return;e.style.display='';e.textContent=msg;}\n"
            "async function pkLoad(){\n"
            "  var box=document.getElementById('pk-list');box.innerHTML='Chargement…';\n"
            "  try{\n"
            "    var d=await fetch('/api/packages').then(r=>r.json());\n"
            "    _pkInstalled=d.packages||[];_pkEnabled=!!d.installEnabled;pkRender();\n"
            "  }catch(e){box.innerHTML='Erreur de chargement.';}\n"
            "}\n"
            "function pkRender(){\n"
            "  var f=(document.getElementById('pk-filter').value||'').toLowerCase();\n"
            "  var list=_pkInstalled.filter(p=>!f||p.name.toLowerCase().includes(f));\n"
            "  document.getElementById('pk-count').textContent=list.length+' / '+_pkInstalled.length;\n"
            "  document.getElementById('pk-list').innerHTML=list.map(p=>(\n"
            "    '<div class=\"act-row\" style=\"margin-bottom:8px\"><div class=\"act-info\"><h3>'+pkEsc(p.name)+'</h3>'+\n"
            "    (p.version?'<p>'+pkEsc(p.version)+'</p>':'')+'</div>'+\n"
            "    (_pkEnabled?'<button class=\"btn btn-g btn-sm\" onclick=\"pkAct(\\'remove\\',\\''+pkEsc(p.name)+'\\')\">Désinstaller</button>':'')+\n"
            "    '</div>'\n"
            "  )).join('')||'<div style=\"color:#64748b;font-size:13px\">Aucun paquet.</div>';\n"
            "}\n"
            "async function pkSearch(){\n"
            "  var q=document.getElementById('pk-query').value.trim();if(!q)return;\n"
            "  var box=document.getElementById('pk-results');box.innerHTML='Recherche…';\n"
            "  try{\n"
            "    var d=await fetch('/api/packages/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q})}).then(r=>r.json());\n"
            "    if(d.error){box.innerHTML=pkEsc(d.error);return;}\n"
            "    _pkEnabled=!!d.installEnabled;var res=d.results||[];\n"
            "    box.innerHTML=res.map(p=>(\n"
            "      '<div class=\"act-row\" style=\"margin-bottom:8px\"><div class=\"act-info\"><h3>'+pkEsc(p.name)+'</h3>'+\n"
            "      (p.summary?'<p>'+pkEsc(p.summary)+'</p>':'')+'</div>'+\n"
            "      (_pkEnabled?'<button class=\"btn btn-p btn-sm\" onclick=\"pkAct(\\'install\\',\\''+pkEsc(p.name)+'\\')\">Installer</button>':'<span style=\"font-size:12px;color:#64748b\">activation requise</span>')+\n"
            "      '</div>'\n"
            "    )).join('')||'<div style=\"color:#64748b;font-size:13px\">Aucun résultat.</div>';\n"
            "  }catch(e){box.innerHTML='Erreur de recherche.';}\n"
            "}\n"
            "async function pkAct(action,name){\n"
            "  var isInstall=action==='install';\n"
            "  if(!await uiConfirm({title:isInstall?'Installer un paquet':'Désinstaller un paquet',\n"
            "    message:(isInstall?'Installer ':'Désinstaller ')+name+' sur cette machine ?',\n"
            "    confirmLabel:isInstall?'Installer':'Désinstaller',danger:!isInstall}))return;\n"
            "  pkOut(action+' '+name+'…');\n"
            "  try{\n"
            "    var d=await fetch('/api/packages/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})}).then(r=>r.json());\n"
            "    pkOut((d.success?'✓ OK':'✗ Échec')+' : '+name+'\\n\\n'+(d.output||d.error||''));\n"
            "    if(d.success&&action==='remove')pkLoad();\n"
            "  }catch(e){pkOut('Erreur réseau : '+e.message);}\n"
            "}\n"
            "function toggleLocalView(mode){\n"
            "  document.querySelectorAll('.view-simple-only').forEach(el=>el.style.display=mode==='simple'?'':'none');\n"
            "  document.querySelectorAll('.view-detailed-only').forEach(el=>el.style.display=mode==='detailed'?'':'none');\n"
            "  const bs=document.getElementById('btn-v-simple');if(bs)bs.classList.toggle('active',mode==='simple');\n"
            "  const bd=document.getElementById('btn-v-detailed');if(bd)bd.classList.toggle('active',mode==='detailed');\n"
            "  localStorage.setItem('local_web_view_mode',mode);\n"
            "}\n"
            "try{\n"
            "  const savedMode=localStorage.getItem('local_web_view_mode')||'simple';\n"
            "  toggleLocalView(savedMode);\n"
            "}catch(e){console.warn('init view mode err',e);}\n"
            "</script>\n"
            "</body></html>"
        )
        self.send_html(html)
    
    # -----------------------------------------------------------------
    #  Reboot
    # -----------------------------------------------------------------
    #
    # Rebooting a machine is destructive and irreversible from the operator's
    # point of view, so a valid session is NOT enough. Every request must carry
    # the OS password of a privileged local account, re-verified here through
    # PAM/shadow. Without a password that authenticates, the machine is never
    # rebooted — an attacker holding a stolen session cookie, or replaying a
    # crafted HTTP request, still cannot trigger it.

    # Reboot is only allowed for root or a member of one of these groups.
    REBOOT_GROUPS = ["sudo", "wheel", "admin", "root"]
    # Password attempts are throttled per IP, independently of the login limiter.
    _MAX_REBOOT_ATTEMPTS = 5
    _REBOOT_WINDOW_S = 300

    def _is_reboot_rate_limited(self, ip: str) -> bool:
        now = time.time()
        _reboot_attempts[ip] = [t for t in _reboot_attempts[ip] if now - t < self._REBOOT_WINDOW_S]
        return len(_reboot_attempts[ip]) >= self._MAX_REBOOT_ATTEMPTS

    def _user_may_reboot(self, username: str) -> bool:
        """True for root, or for a member of an administrative group."""
        if username == "root":
            return True
        try:
            auth = get_pam_auth()
        except Exception:
            return False
        try:
            return bool(auth._user_in_groups(username, self.REBOOT_GROUPS))
        except Exception:
            return False

    def api_reboot(self, data: dict, session_username: str):
        client_ip = self._get_client_ip()

        if self._is_reboot_rate_limited(client_ip):
            log(f"[reboot] refusé: trop de tentatives depuis {client_ip}")
            self.send_json(
                {"error": "Trop de tentatives. Réessayez dans quelques minutes."}, 429
            )
            return

        if not get_pam_auth:
            log("[reboot] refusé: authentification indisponible")
            self.send_json({"error": "Authentification indisponible sur cette machine"}, 503)
            return

        # The account being verified defaults to the logged-in user; an operator
        # may instead supply root's credentials.
        username = str(data.get("username") or session_username or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            _reboot_attempts[client_ip].append(time.time())
            self.send_json({"error": "Mot de passe requis"}, 400)
            return

        try:
            success, message = get_pam_auth().authenticate(username, password)
        except Exception as exc:
            log(f"[reboot] erreur d'authentification: {exc}")
            self.send_json({"error": "Authentification indisponible"}, 503)
            return
        finally:
            # Do not keep the secret around any longer than necessary.
            password = None
            data.pop("password", None)

        if not success:
            _reboot_attempts[client_ip].append(time.time())
            log(f"[reboot] REFUSÉ: mot de passe invalide pour '{username}' depuis {client_ip}")
            self.send_json({"error": "Mot de passe invalide — redémarrage refusé"}, 401)
            return

        if not self._user_may_reboot(username):
            _reboot_attempts[client_ip].append(time.time())
            log(f"[reboot] REFUSÉ: '{username}' n'est pas administrateur (depuis {client_ip})")
            self.send_json(
                {"error": "Cet utilisateur n'est pas autorisé à redémarrer la machine"}, 403
            )
            return

        _reboot_attempts.pop(client_ip, None)
        delay_minutes = 1
        log(
            f"[reboot] AUTORISÉ par '{username}' depuis {client_ip} — "
            f"redémarrage dans {delay_minutes} minute(s)"
        )

        ok, detail = self._schedule_reboot(username, delay_minutes)
        if not ok:
            self.send_json({"error": f"Échec de la planification du redémarrage: {detail}"}, 500)
            return

        self.send_json({
            "success": True,
            "delayMinutes": delay_minutes,
            "message": (
                f"Redémarrage planifié dans {delay_minutes} minute(s). "
                "Annulation possible sur la machine avec: shutdown -c"
            ),
        })

    def _schedule_reboot(self, username: str, delay_minutes: int):
        """
        Ask the OS to reboot. Returns (ok, detail).

        A short delay is used rather than an immediate reboot so the HTTP
        response reaches the browser first, and so an operator who realises the
        mistake can still run `shutdown -c` on the machine.
        """
        import subprocess

        reason = f"Redemarrage demande via l'interface locale AAUL par {username}"
        commands = [
            ["shutdown", "-r", f"+{delay_minutes}", reason],
            ["/sbin/shutdown", "-r", f"+{delay_minutes}", reason],
            ["systemctl", "reboot"],
        ]
        need_sudo = os.name != "nt" and hasattr(os, "geteuid") and os.geteuid() != 0

        last_error = "aucune commande disponible"
        for cmd in commands:
            full = (["sudo", "-n"] + cmd) if need_sudo else cmd
            try:
                proc = subprocess.run(full, capture_output=True, text=True, timeout=15)
            except FileNotFoundError:
                last_error = f"{cmd[0]} introuvable"
                continue
            except subprocess.TimeoutExpired:
                last_error = f"{cmd[0]}: delai depasse"
                continue
            if proc.returncode == 0:
                return True, cmd[0]
            last_error = (proc.stderr or proc.stdout or "").strip()[:200] or f"code {proc.returncode}"
        log(f"[reboot] echec de la planification: {last_error}")
        return False, last_error

    def api_status(self):
        """API: Get agent status including live resource metrics."""
        state = read_state()

        try:
            sys_info = collect_system_info()
        except:
            sys_info = {}

        def fmt_ts(iso_str):
            if not iso_str:
                return None
            try:
                from datetime import datetime
                dt = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
                return dt.astimezone().strftime('%Y-%m-%d %H:%M:%S')
            except:
                return iso_str

        self.send_json({
            "status": "online",
            "hostname": get_hostname(),
            "ip": get_primary_ip(),
            "version": get_agent_version(),
            "lastPoll": fmt_ts(state.get("lastPoll")),
            "lastUpdate": fmt_ts(state.get("lastUpdate")),
            "rebootRequired": get_reboot_required(),
            "cpu": sys_info.get("cpu", {}),
            "memory": sys_info.get("memory", {}),
            "uptimeSeconds": get_uptime_seconds(),
        })
    
    def api_info(self):
        """API: Get detailed system info."""
        try:
            sys_info = collect_system_info()
            self.send_json(sys_info)
        except Exception as e:
            log(f"Erreur api_info: {e}")
            self.send_json({"error": "Internal server error"}, 500)
    
    def api_logs(self):
        """API: Get recent agent logs (the agent writes dated files agent-YYYY-MM-DD.log)."""
        try:
            candidates = sorted(LOG_DIR.glob("agent-*.log")) if LOG_DIR.exists() else []
            legacy = LOG_DIR / "agent.log"
            if legacy.exists():
                candidates.append(legacy)
            if not candidates:
                self.send_json({"logs": []})
                return
            log_file = candidates[-1]  # most recent
            lines = log_file.read_text(encoding="utf-8", errors="replace").strip().split("\n")[-100:]
            self.send_json({"logs": lines})
        except Exception as e:
            log(f"Erreur api_logs: {e}")
            self.send_json({"error": "Internal server error"}, 500)

    def api_firewall_status(self):
        """API: Get firewall status."""
        if not FIREWALL_AVAILABLE:
            self.send_json({"available": False})
            return
        
        fw = get_firewall_manager()
        self.send_json({
            "available": True,
            **fw.get_status()
        })
    
    def api_run_update(self):
        """API: Trigger an update check."""
        try:
            # Import and run the update from agent_runner
            import sys
            from pathlib import Path
            # Add parent directory to path to import agent_runner
            app_dir = Path(__file__).parent.parent
            if str(app_dir) not in sys.path:
                sys.path.insert(0, str(app_dir))
            from agent_runner import run_update
            result = run_update()
            self.send_json({
                "success": True, 
                "status": result.get("status"),
                "message": result.get("message", "Mise à jour terminée")
            })
        except Exception as e:
            log(f"Erreur lors de la mise à jour: {e}")
            self.send_json({"success": False, "error": "Update failed"}, 500)

    def _packages_enabled(self) -> bool:
        """Whether install/remove are permitted from this interface."""
        return bool(getattr(self.manager, "packages_enabled", False))

    def api_packages_list(self):
        """API: list installed packages (read-only, always allowed)."""
        try:
            from .packages import list_installed
            result = list_installed()
            result["installEnabled"] = self._packages_enabled()
            self.send_json(result)
        except Exception as e:
            log(f"Erreur api_packages_list: {e}")
            self.send_json({"error": "Listing échoué"}, 500)

    def api_packages_search(self, data):
        """API: search available packages (read-only, always allowed)."""
        try:
            from .packages import search, PackageError
            try:
                result = search(data.get("query"))
            except PackageError as pe:
                self.send_json({"error": str(pe)}, 400)
                return
            result["installEnabled"] = self._packages_enabled()
            self.send_json(result)
        except Exception as e:
            log(f"Erreur api_packages_search: {e}")
            self.send_json({"error": "Recherche échouée"}, 500)

    def api_package_action(self, data, action):
        """API: install/remove a package (gated by opt-in)."""
        if not self._packages_enabled():
            self.send_json({"error": "Gestion des paquets désactivée pour cet agent"}, 403)
            return
        try:
            from .packages import install, remove, PackageError
            name = data.get("name")
            try:
                result = (install if action == "install" else remove)(name)
            except PackageError as pe:
                self.send_json({"success": False, "error": str(pe)}, 400)
                return
            self.send_json(result, 200 if result.get("success") else 500)
        except Exception as e:
            log(f"Erreur api_package_action({action}): {e}")
            self.send_json({"success": False, "error": "Opération échouée"}, 500)


class LocalWebManager:
    """
    Manages the local web server lifecycle, including:
    - Starting/stopping the server
    - Firewall configuration
    - Configuration persistence
    """
    
    def __init__(self):
        self.server: Optional[ThreadedHTTPServer] = None
        self.server_thread: Optional[threading.Thread] = None
        self.current_port: Optional[int] = None
        self.enabled: bool = False
        self.packages_enabled: bool = False

        # Load saved state
        self._load_state()
    
    def _load_state(self):
        """Load saved state from file."""
        try:
            if LOCAL_WEB_STATE_FILE.exists():
                data = json.loads(LOCAL_WEB_STATE_FILE.read_text())
                self.current_port = data.get("port")
                self.enabled = data.get("enabled", False)
        except (json.JSONDecodeError, IOError) as e:
            log(f"Erreur lecture état local web: {e}")
    
    def _save_state(self):
        """Save current state to file."""
        try:
            LOCAL_WEB_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
            LOCAL_WEB_STATE_FILE.write_text(json.dumps({
                "port": self.current_port,
                "enabled": self.enabled
            }, indent=2))
        except IOError as e:
            log(f"Erreur sauvegarde état local web: {e}")
    
    def apply_config(self, config: dict):
        """
        Apply configuration received from the dashboard.
        
        This handles:
        - Enabling/disabling the local web server
        - Changing ports
        - Managing firewall rules
        
        Args:
            config: Agent configuration with localWeb settings
        """
        local_web_config = config.get("localWeb", {})
        new_enabled = local_web_config.get("enabled", False)
        new_port = local_web_config.get("port", 8180)
        # Whether install/remove are allowed from the local interface (opt-in).
        self.packages_enabled = bool(local_web_config.get("packagesEnabled", False))

        if platform.system() != "Linux" and new_enabled:
            log("Local web interface is supported on Linux agents only.")
            new_enabled = False
        
        # Validate port
        if new_port not in ALLOWED_PORTS:
            log(f"Port {new_port} non autorisé. Ports valides: {ALLOWED_PORTS}")
            new_port = 8180
        
        log(f"Application config local web: enabled={new_enabled}, port={new_port}")
        
        # Case 1: Disable
        if not new_enabled:
            if self.enabled:
                self._stop_server()
                self._close_firewall_port()
            self.enabled = False
            self._save_state()
            return
        
        # Case 2: Enable or change port
        log(f"[LocalWeb] État actuel: enabled={self.enabled}, current_port={self.current_port}, server_running={self.server is not None}")
        if self.enabled and self.current_port != new_port:
            # Port change - stop old, open new firewall, start new
            self._stop_server()
            if FIREWALL_AVAILABLE:
                update_port(self.current_port, new_port)
            self.current_port = new_port
            self._start_server(new_port, local_web_config)
        elif self.enabled and self.current_port == new_port and self.server is None:
            # Server was enabled but crashed/restarted - restart it
            log(f"[LocalWeb] Serveur était activé mais non actif, redémarrage sur port {new_port}")
            self._start_server(new_port, local_web_config)
        elif not self.enabled:
            # Fresh start
            log(f"[LocalWeb] Démarrage initial sur port {new_port}")
            if FIREWALL_AVAILABLE:
                open_port(new_port)
            self.current_port = new_port
            self._start_server(new_port, local_web_config)
        
        self.enabled = True
        self._save_state()
    
    def _start_server(self, port: int, config: dict):
        """Start the HTTP server on the specified port."""
        try:
            log(f"[LocalWeb] Tentative démarrage serveur sur port {port}")
            AgentWebHandler.manager = self
            self.server = ThreadedHTTPServer(("0.0.0.0", port), AgentWebHandler)
            
            # Enable HTTPS if certificates are configured
            ssl_config = config.get("ssl", {})
            if ssl_config.get("enabled"):
                cert_path = ssl_config.get("certPath")
                key_path = ssl_config.get("keyPath")
                if cert_path and key_path:
                    cert_path = Path(cert_path)
                    key_path = Path(key_path)
                    if cert_path.exists() and key_path.exists():
                        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                        context.load_cert_chain(str(cert_path), str(key_path))
                        self.server.socket = context.wrap_socket(
                            self.server.socket, server_side=True
                        )
                        log(f"[LocalWeb] HTTPS activé sur port {port}")
            
            self.server_thread = threading.Thread(
                target=self.server.serve_forever,
                daemon=True
            )
            self.server_thread.start()
            
            protocol = "https" if ssl_config.get("enabled") else "http"
            log(f"[LocalWeb] Serveur démarré: {protocol}://0.0.0.0:{port}")
            
        except Exception as e:
            log(f"[LocalWeb] Échec démarrage serveur: {e}")
            self.server = None
            self.server_thread = None
    
    def _stop_server(self):
        """Stop the HTTP server if running."""
        if self.server:
            try:
                self.server.shutdown()
                log("[LocalWeb] Serveur arrêté")
            except Exception as e:
                log(f"[LocalWeb] Erreur arrêt serveur: {e}")
            finally:
                self.server = None
                self.server_thread = None
    
    def _close_firewall_port(self):
        """Close the firewall port."""
        if FIREWALL_AVAILABLE and self.current_port:
            close_port(self.current_port)
            self.current_port = None
    
    def stop(self):
        """Stop the server and clean up firewall."""
        self._stop_server()
        self._close_firewall_port()
        self.enabled = False
        self._save_state()
    
    def is_running(self) -> bool:
        """Check if the server is running."""
        return self.server is not None
    
    def get_status(self) -> dict:
        """Get the current status of the local web server."""
        firewall_status = None
        if FIREWALL_AVAILABLE:
            fw = get_firewall_manager()
            firewall_status = fw.get_status()
        
        return {
            "enabled": self.enabled,
            "running": self.is_running(),
            "port": self.current_port,
            "firewall": firewall_status
        }


_manager: Optional[LocalWebManager] = None


def get_local_web_manager() -> LocalWebManager:
    """Get the singleton LocalWebManager instance."""
    global _manager
    if _manager is None:
        _manager = LocalWebManager()
    return _manager


def start_local_server(config: dict) -> bool:
    """Start the local web server if enabled in config."""
    manager = get_local_web_manager()
    manager.apply_config(config)
    return manager.is_running()


def stop_local_server():
    """Stop the local web server."""
    if _manager:
        _manager.stop()


def is_server_running() -> bool:
    """Check if the local web server is running."""
    return _manager is not None and _manager.is_running()
