package packages

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
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
	locateOnce sync.Once
	wingetPath string
	locateErr  error
)

// Locate resolves the winget executable.
//
// This matters more than it looks. `winget.exe` on PATH is an app-execution
// alias living in the *user's* %LOCALAPPDATA%\Microsoft\WindowsApps, which does
// not exist for the LocalSystem account the service runs under: a plain
// exec.LookPath("winget") finds nothing in service context. The real executable
// ships inside the Microsoft.DesktopAppInstaller package under
// C:\Program Files\WindowsApps, which SYSTEM can read, so that directory is
// searched as well.
func Locate() (string, error) {
	locateOnce.Do(func() {
		if path, err := exec.LookPath("winget"); err == nil {
			wingetPath = path
			return
		}
		if path := findInWindowsApps(); path != "" {
			wingetPath = path
			return
		}
		locateErr = &Error{"winget est introuvable sur cette machine"}
	})
	return wingetPath, locateErr
}

// appInstallerPattern matches every installed version of the App Installer
// package, for either architecture.
const appInstallerPattern = "Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe"

func findInWindowsApps() string {
	programFiles := os.Getenv("ProgramFiles")
	if programFiles == "" {
		programFiles = `C:\Program Files`
	}
	matches, err := filepath.Glob(filepath.Join(programFiles, "WindowsApps", appInstallerPattern, "winget.exe"))
	if err != nil || len(matches) == 0 {
		return ""
	}

	// Several versions can be staged side by side; the newest is the one the
	// alias would have resolved to.
	best := ""
	bestVersion := ""
	for _, match := range matches {
		version := packageVersionFromPath(match)
		if best == "" || compareVersions(version, bestVersion) > 0 {
			best, bestVersion = match, version
		}
	}
	return best
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
