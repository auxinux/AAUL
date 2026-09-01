"""Detects the active Linux firewall (UFW, firewalld, or iptables) and opens
or closes ports through it for the agent's local web interface, tracking
what it opened so it can clean up when the interface is disabled.
"""

import subprocess
import os
import json
from pathlib import Path
from typing import Optional, Tuple, List

from lib.logs import log


FIREWALL_STATE_FILE = "/var/lib/autoupdate-agent/firewall_state.json"


class FirewallManager:
    """Detects the active firewall and provides a unified open/close-port API."""

    def __init__(self):
        self.firewall_type = self._detect_firewall()
        self.state = self._load_state()
        log(f"Firewall détecté: {self.firewall_type or 'aucun'}")

    def _detect_firewall(self) -> Optional[str]:
        if self._is_ufw_active():
            return 'ufw'
        if self._is_firewalld_active():
            return 'firewalld'
        if self._is_iptables_active():
            return 'iptables'
        return None

    def _is_ufw_active(self) -> bool:
        """Check if UFW is installed and active."""
        try:
            result = subprocess.run(
                ['ufw', 'status'],
                capture_output=True, text=True, timeout=10
            )
            return 'Status: active' in result.stdout
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
    
    def _is_firewalld_active(self) -> bool:
        """Check if firewalld is installed and running."""
        try:
            result = subprocess.run(
                ['systemctl', 'is-active', 'firewalld'],
                capture_output=True, text=True, timeout=10
            )
            return result.stdout.strip() == 'active'
        except (FileNotFoundError, subprocess.TimeoutExpired):
            return False
    
    def _is_iptables_active(self) -> bool:
        """Check if iptables has rules (indicating it's being used)."""
        try:
            result = subprocess.run(
                ['iptables', '-L', '-n'],
                capture_output=True, text=True, timeout=10
            )
            # More than the default ACCEPT boilerplate (~6 lines) means custom rules exist.
            lines = result.stdout.strip().split('\n')
            return len(lines) > 6
        except (FileNotFoundError, subprocess.TimeoutExpired, PermissionError):
            return False
    
    def _load_state(self) -> dict:
        """Load the firewall state from the state file."""
        try:
            if os.path.exists(FIREWALL_STATE_FILE):
                with open(FIREWALL_STATE_FILE, 'r') as f:
                    return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            log(f"Erreur lecture état firewall: {e}")
        return {"opened_ports": []}
    
    def _save_state(self):
        """Save the firewall state to the state file."""
        try:
            state_dir = os.path.dirname(FIREWALL_STATE_FILE)
            os.makedirs(state_dir, exist_ok=True)
            with open(FIREWALL_STATE_FILE, 'w') as f:
                json.dump(self.state, f, indent=2)
        except IOError as e:
            log(f"Erreur sauvegarde état firewall: {e}")
    
    def _run_command(self, cmd: List[str]) -> Tuple[bool, str]:
        """Run a firewall command, prefixing with sudo if not already root."""
        try:
            if os.geteuid() != 0:
                cmd = ['sudo'] + cmd

            result = subprocess.run(
                cmd,
                capture_output=True, text=True, timeout=30
            )
            
            if result.returncode == 0:
                return True, result.stdout.strip()
            else:
                return False, result.stderr.strip() or result.stdout.strip()
        except subprocess.TimeoutExpired:
            return False, "Commande timeout"
        except FileNotFoundError:
            return False, f"Commande non trouvée: {cmd[0]}"
        except Exception as e:
            return False, str(e)
    
    def open_port(self, port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
        if not self.firewall_type:
            log(f"Aucun firewall actif, port {port} accessible par défaut")
            return True, "Aucun firewall actif"

        log(f"Ouverture port {port}/{protocol} via {self.firewall_type}")

        success = False
        message = ""

        if self.firewall_type == 'ufw':
            success, message = self._ufw_open_port(port, protocol)
        elif self.firewall_type == 'firewalld':
            success, message = self._firewalld_open_port(port, protocol)
        elif self.firewall_type == 'iptables':
            success, message = self._iptables_open_port(port, protocol)

        if success:
            port_entry = {"port": port, "protocol": protocol}
            if port_entry not in self.state["opened_ports"]:
                self.state["opened_ports"].append(port_entry)
                self._save_state()
            log(f"Port {port}/{protocol} ouvert avec succès")
        else:
            log(f"Échec ouverture port {port}/{protocol}: {message}")

        return success, message

    def close_port(self, port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
        if not self.firewall_type:
            return True, "Aucun firewall actif"

        log(f"Fermeture port {port}/{protocol} via {self.firewall_type}")

        success = False
        message = ""

        if self.firewall_type == 'ufw':
            success, message = self._ufw_close_port(port, protocol)
        elif self.firewall_type == 'firewalld':
            success, message = self._firewalld_close_port(port, protocol)
        elif self.firewall_type == 'iptables':
            success, message = self._iptables_close_port(port, protocol)

        if success:
            port_entry = {"port": port, "protocol": protocol}
            if port_entry in self.state["opened_ports"]:
                self.state["opened_ports"].remove(port_entry)
                self._save_state()
            log(f"Port {port}/{protocol} fermé avec succès")
        else:
            log(f"Échec fermeture port {port}/{protocol}: {message}")

        return success, message

    def close_all_tracked_ports(self) -> List[Tuple[int, bool, str]]:
        """Close every port this agent has opened. Returns (port, success, message) tuples."""
        results = []
        for entry in list(self.state["opened_ports"]):
            success, message = self.close_port(entry["port"], entry["protocol"])
            results.append((entry["port"], success, message))
        return results

    def update_port(self, old_port: int, new_port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
        if old_port == new_port:
            return True, "Port inchangé"

        log(f"Modification port firewall: {old_port} -> {new_port}")

        # Open the new port before closing the old one, so access isn't lost if the close fails.
        success, message = self.open_port(new_port, protocol)
        if not success:
            return False, f"Échec ouverture nouveau port: {message}"

        close_success, close_message = self.close_port(old_port, protocol)
        if not close_success:
            log(f"Avertissement: ancien port {old_port} non fermé: {close_message}")

        return True, f"Port changé de {old_port} à {new_port}"

    # UFW (Ubuntu/Debian)

    def _ufw_open_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Open a port using UFW."""
        return self._run_command(['ufw', 'allow', f'{port}/{protocol}'])
    
    def _ufw_close_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Close a port using UFW."""
        return self._run_command(['ufw', 'delete', 'allow', f'{port}/{protocol}'])
    
    # =========================================================================
    # firewalld (Fedora/RHEL/CentOS)
    # =========================================================================
    
    def _firewalld_open_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Open a port using firewalld."""
        # Add to permanent config
        success, message = self._run_command([
            'firewall-cmd', '--permanent', '--add-port', f'{port}/{protocol}'
        ])
        if not success:
            return success, message
        
        # Reload to apply
        return self._run_command(['firewall-cmd', '--reload'])
    
    def _firewalld_close_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Close a port using firewalld."""
        # Remove from permanent config
        success, message = self._run_command([
            'firewall-cmd', '--permanent', '--remove-port', f'{port}/{protocol}'
        ])
        if not success:
            return success, message
        
        # Reload to apply
        return self._run_command(['firewall-cmd', '--reload'])
    
    # =========================================================================
    # iptables (generic/fallback)
    # =========================================================================
    
    def _iptables_open_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Open a port using iptables."""
        # Check if rule already exists
        check_cmd = [
            'iptables', '-C', 'INPUT', '-p', protocol,
            '--dport', str(port), '-j', 'ACCEPT'
        ]
        exists, _ = self._run_command(check_cmd)

        if exists:
            return True, "Règle existe déjà"

        success, message = self._run_command([
            'iptables', '-I', 'INPUT', '-p', protocol,
            '--dport', str(port), '-j', 'ACCEPT'
        ])

        if success:
            self._save_iptables()

        return success, message
    
    def _iptables_close_port(self, port: int, protocol: str) -> Tuple[bool, str]:
        """Close a port using iptables."""
        success, message = self._run_command([
            'iptables', '-D', 'INPUT', '-p', protocol,
            '--dport', str(port), '-j', 'ACCEPT'
        ])
        
        if success:
            self._save_iptables()
        
        return success, message
    
    def _save_iptables(self):
        """Persist iptables rules, trying each distro-specific method until one works."""
        save_commands = [
            ['iptables-save', '-f', '/etc/iptables/rules.v4'],  # Debian/Ubuntu
            ['service', 'iptables', 'save'],                     # RHEL/CentOS
            ['netfilter-persistent', 'save'],                    # Debian with netfilter-persistent
        ]

        for cmd in save_commands:
            success, _ = self._run_command(cmd)
            if success:
                log(f"Règles iptables sauvegardées via {cmd[0]}")
                return

        log("Avertissement: Règles iptables non persistées (redémarrage les effacera)")

    def get_status(self) -> dict:
        return {
            "firewall_type": self.firewall_type,
            "active": self.firewall_type is not None,
            "opened_ports": self.state["opened_ports"]
        }


_firewall_manager: Optional[FirewallManager] = None


def get_firewall_manager() -> FirewallManager:
    """Get the singleton FirewallManager instance."""
    global _firewall_manager
    if _firewall_manager is None:
        _firewall_manager = FirewallManager()
    return _firewall_manager


def open_port(port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
    """Convenience function to open a port."""
    return get_firewall_manager().open_port(port, protocol)


def close_port(port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
    """Convenience function to close a port."""
    return get_firewall_manager().close_port(port, protocol)


def update_port(old_port: int, new_port: int, protocol: str = 'tcp') -> Tuple[bool, str]:
    """Convenience function to change a port."""
    return get_firewall_manager().update_port(old_port, new_port, protocol)
