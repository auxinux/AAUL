package packages

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// queryTimeout covers read-only commands (list, search, upgrade).
	queryTimeout = 60 * time.Second
	// actionTimeout covers install, uninstall and upgrade of a package.
	actionTimeout = 300 * time.Second
)

var (
	locateMu   sync.Mutex
	wingetPath string
)

// Locate resolves a winget executable that actually runs in this process's
// context, and caches it.
//
// Finding the file is not enough. The `winget` on PATH is an app-execution
// alias living in the *user's* %LOCALAPPDATA%\Microsoft\WindowsApps, which does
// not exist for the LocalSystem account the service runs under. The real
// executable ships inside the Microsoft.DesktopAppInstaller package under
// C:\Program Files\WindowsApps, but that path is not always launchable either:
// it is an MSIX package directory, and a service can be able to list it while
// CreateProcess still fails with "the specified path could not be found".
//
// So every candidate is probed by actually running `winget --version`, and the
// first one that answers wins. A failure is not cached: a service runs for
// months, and App Installer can be provisioned or repaired underneath it.
func Locate() (string, error) {
	locateMu.Lock()
	defer locateMu.Unlock()

	if wingetPath != "" {
		return wingetPath, nil
	}
	path, err := resolveWinget()
	if err != nil {
		return "", err
	}
	wingetPath = path
	return path, nil
}

func resolveWinget() (string, error) {
	candidates := []string{}
	if path, err := exec.LookPath("winget"); err == nil {
		candidates = append(candidates, path)
	}
	candidates = append(candidates, windowsAppsCandidates()...)

	if len(candidates) == 0 {
		return "", &Error{"winget est introuvable sur cette machine (App Installer absent ?)"}
	}

	// The report is what reaches the dashboard when nothing works. Guessing
	// from "winget failed" is what made this expensive to diagnose the first
	// time, so the failure carries every path tried and why each one refused.
	var report strings.Builder
	for _, candidate := range candidates {
		if err := probeWinget(candidate); err != nil {
			fmt.Fprintf(&report, "\n  %s -> %v", candidate, err)
			continue
		}
		return candidate, nil
	}
	return "", &Error{"winget est present mais aucun chemin n'est executable dans ce contexte :" + report.String()}
}

// probeTimeout bounds the `winget --version` check. A cold MSIX start is slow
// the first time, but nothing like a package operation.
const probeTimeout = 20 * time.Second

func probeWinget(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	output, err := exec.CommandContext(ctx, path, "--version").CombinedOutput()
	if ctx.Err() == context.DeadlineExceeded {
		return fmt.Errorf("pas de reponse en %s", probeTimeout)
	}
	if err != nil {
		detail := strings.TrimSpace(string(output))
		if detail == "" {
			return err
		}
		return fmt.Errorf("%v (%s)", err, detail)
	}
	return nil
}

// appInstallerPattern matches every installed version of the App Installer
// package, for either architecture.
const appInstallerPattern = "Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe"

// windowsAppsCandidates lists every staged App Installer package, newest first.
//
// All of them are returned rather than just the newest: when several versions
// are staged, the newest is not necessarily the one this account can launch.
func windowsAppsCandidates() []string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	matches, err := filepath.Glob(filepath.Join(programFiles, "WindowsApps", appInstallerPattern, "winget.exe"))
	if err != nil || len(matches) == 0 {
		return nil
	}
	sort.Slice(matches, func(i, j int) bool {
		return compareVersions(packageVersionFromPath(matches[i]), packageVersionFromPath(matches[j])) > 0
	})
	return matches
}

// packageVersionFromPath pulls "1.24.25200.0" out of a path ending in
// Microsoft.DesktopAppInstaller_1.24.25200.0_x64__8wekyb3d8bbwe\winget.exe.
func packageVersionFromPath(path string) string {
	// Split on both separators rather than using filepath, so the parsing is
	// identical when the unit tests run on the Linux build host.
	segments := strings.FieldsFunc(path, func(r rune) bool { return r == '\\' || r == '/' })
	if len(segments) < 2 {
		return ""
	}
	directory := segments[len(segments)-2]
	parts := strings.Split(directory, "_")
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

// compareVersions compares dotted numeric versions. Non-numeric components sort
// as zero, which is enough to pick the newest staged package.
func compareVersions(left, right string) int {
	leftParts := strings.Split(left, ".")
	rightParts := strings.Split(right, ".")
	count := len(leftParts)
	if len(rightParts) > count {
		count = len(rightParts)
	}
	for index := 0; index < count; index++ {
		leftValue, rightValue := 0, 0
		if index < len(leftParts) {
			leftValue, _ = strconv.Atoi(leftParts[index])
		}
		if index < len(rightParts) {
			rightValue, _ = strconv.Atoi(rightParts[index])
		}
		if leftValue != rightValue {
			if leftValue > rightValue {
				return 1
			}
			return -1
		}
	}
	return 0
}

// readOnlyCommands must never block on winget's first-run source agreement
// prompt, which would otherwise hang until the timeout on a fresh machine.
var readOnlyCommands = map[string]bool{"list": true, "search": true, "upgrade": true}

// run executes winget with a fixed argument list and returns the combined
// output. A non-zero exit is returned as an error but the output is still
// returned, because the transcript is what the operator needs to see.
func run(timeout time.Duration, args ...string) (string, error) {
	binary, err := Locate()
	if err != nil {
		return "", err
	}

	full := append([]string{}, args...)
	if len(args) > 0 && readOnlyCommands[args[0]] && !hasFlag(args, "--accept-source-agreements") {
		full = append(full, "--accept-source-agreements")
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	command := exec.CommandContext(ctx, binary, full...)
	output, runErr := command.CombinedOutput()
	text := string(output)

	if ctx.Err() == context.DeadlineExceeded {
		return text, &Error{fmt.Sprintf("Délai dépassé (winget %s)", strings.Join(args, " "))}
	}
	return text, runErr
}

func hasFlag(args []string, flag string) bool {
	for _, arg := range args {
		if arg == flag {
			return true
		}
	}
	return false
}
