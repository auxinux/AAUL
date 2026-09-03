// Package config owns the agent's on-disk state: where it lives and how it is
// read and written.
//
// The layout deliberately matches the Python agent it replaces
// (agent/app/lib/config.py): same directory, same file names, same JSON schema.
// A machine migrated from the Python agent therefore keeps its identity, its
// token and its log history — the dashboard never notices the swap.
package config

import (
	"bytes"
	"os"
	"path/filepath"
)

// utf8BOM is the byte-order mark Windows tooling likes to prepend to text files.
var utf8BOM = []byte{0xEF, 0xBB, 0xBF}

// ReadJSONFile reads a JSON file, tolerating a leading UTF-8 BOM.
//
// This is not hypothetical. Windows PowerShell 5.1 writes a BOM for
// `Set-Content -Encoding UTF8` (PowerShell 7 does not, which makes the
// behaviour depend on which one wrote the file), and encoding/json rejects it
// with "invalid character '\ufeff' looking for beginning of value". Notepad
// adds one too. The agent has to read whatever an installer or an administrator
// actually put on disk.
func ReadJSONFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return bytes.TrimPrefix(data, utf8BOM), nil
}

// Default runtime root. %PROGRAMDATA% is empty on non-Windows hosts, which only
// happens when running the unit tests, and those override AAUL_RUNTIME_DIR.
func defaultRuntimeDir() string {
	programData := os.Getenv("PROGRAMDATA")
	if programData == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "AgentAutoUpdate")
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

// RuntimeDir is the root of everything the agent persists.
func RuntimeDir() string {
	return envOr("AAUL_RUNTIME_DIR", defaultRuntimeDir())
}

// ConfigPath holds the identity and connection settings written by the installer.
func ConfigPath() string {
	return envOr("AAUL_CONFIG_PATH", filepath.Join(RuntimeDir(), "config.json"))
}

// StatePath holds volatile run results reported back on the next poll.
func StatePath() string {
	return envOr("AAUL_STATE_PATH", filepath.Join(RuntimeDir(), "state.json"))
}

// LogDir holds one agent-YYYY-MM-DD.log per day.
func LogDir() string {
	return envOr("AAUL_LOG_DIR", filepath.Join(RuntimeDir(), "logs"))
}

// SecurityConfigPath holds the TLS and signing policy.
func SecurityConfigPath() string {
	return envOr("AAUL_SECURITY_CONFIG_PATH", filepath.Join(RuntimeDir(), "security.json"))
}

// BinDir is where the agent executable lives. Self-update writes its temporary
// files next to it, so it must be on the same volume as the running binary.
func BinDir() string {
	return envOr("AAUL_BIN_DIR", filepath.Join(RuntimeDir(), "bin"))
}

// EnsureRuntimeDirs creates the directories the agent writes to.
func EnsureRuntimeDirs() error {
	for _, dir := range []string{RuntimeDir(), LogDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	return nil
}
