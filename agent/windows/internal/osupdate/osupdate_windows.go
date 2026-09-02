//go:build windows

// Package osupdate applies operating-system updates.
//
// Two mechanisms run in order, mirroring the Python agent
// (agent/app/lib/package_manager.py:get_update_commands):
//
//  1. winget upgrades the third-party software inventory;
//  2. a PowerShell script drives the Microsoft.Update.Session COM API for
//     Windows Update itself.
//
// The second one is the only place this agent still spawns PowerShell. Windows
// Update has no command-line interface worth the name, and PowerShell ships with
// Windows — unlike the Python runtime this agent exists to stop installing.
package osupdate

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"aaul-agent/internal/config"
	"aaul-agent/internal/logs"
	"aaul-agent/internal/packages"
)

// windowsUpdateScript searches for, downloads and installs all applicable
// software updates.
//
// ResultCode > 3 means the operation did not succeed: 2 is "succeeded",
// 3 is "succeeded with errors", and anything above is a failure.
const windowsUpdateScript = `$session = New-Object -ComObject Microsoft.Update.Session;` +
	`$searcher = $session.CreateUpdateSearcher();` +
	`$result = $searcher.Search("IsInstalled=0 and Type='Software'");` +
	`if ($result.Updates.Count -eq 0) { exit 0 };` +
	`$updates = New-Object -ComObject Microsoft.Update.UpdateColl;` +
	`foreach ($update in $result.Updates) {` +
	`  if (-not $update.EulaAccepted) { $update.AcceptEula() | Out-Null };` +
	`  [void]$updates.Add($update)` +
	`};` +
	`$downloader = $session.CreateUpdateDownloader();` +
	`$downloader.Updates = $updates;` +
	`$downloadResult = $downloader.Download();` +
	`if ($downloadResult.ResultCode -gt 3) { exit 1 };` +
	`$installer = $session.CreateUpdateInstaller();` +
	`$installer.Updates = $updates;` +
	`$installResult = $installer.Install();` +
	`if ($installResult.ResultCode -gt 3) { exit 1 }`

// updateTimeout bounds a single update step. Windows Update on a machine that
// has been offline for months can legitimately take over an hour.
const updateTimeout = 3 * time.Hour

// Result is what an update run reports back to the dashboard.
type Result struct {
	Status   string
	ExitCode int
	Duration int
	LogPath  string
	Message  string
}

// buildCommands returns the ordered update commands for this host.
//
// winget is optional: a Windows Server install may not have App Installer, and
// Windows Update alone is still worth running there.
func buildCommands() [][]string {
	commands := [][]string{}
	if binary, err := packages.Locate(); err == nil {
		commands = append(commands, []string{binary, "upgrade", "--all", "--silent",
			"--accept-package-agreements", "--accept-source-agreements"})
	} else {
		logs.Append("[update] winget unavailable, running Windows Update only: %v", err)
	}
	commands = append(commands, []string{"powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-Command", windowsUpdateScript})
	return commands
}

// Run applies all updates and records the outcome in the agent state.
//
// It never returns an error: a failed update is a reportable result, not an
// agent malfunction, and the dashboard wants the exit code and the transcript.
func Run(streamOutput bool) Result {
	lock := acquireLock()
	if lock == nil {
		return Result{Status: "ERROR", ExitCode: 1, Message: "Update already running"}
	}
	defer lock.release()

	start := time.Now()
	logPath := logs.Path()
	status := "OK"
	exitCode := 0
	message := ""

	logs.AppendRaw(logPath, fmt.Sprintf("\nSTART: %s\n", humanNow()))

	for _, command := range buildCommands() {
		code, err := runCommand(command, logPath, streamOutput)
		if err != nil {
			status = "ERROR"
			exitCode = code
			message = err.Error()
			break
		}
		if code != 0 {
			status = "ERROR"
			exitCode = code
			break
		}
	}

	duration := int(time.Since(start).Seconds())
	logs.AppendRaw(logPath, fmt.Sprintf("END: %s | status=%s | exit=%d | duration=%ds\n",
		humanNow(), status, exitCode, duration))

	recordState(status, exitCode, duration)

	return Result{Status: status, ExitCode: exitCode, Duration: duration, LogPath: logPath, Message: message}
}

func humanNow() string {
	return time.Now().Format("2006-01-02 15:04:05")
}

func recordState(status string, exitCode, duration int) {
	state := config.ReadState()
	now := logs.UTCNowISO()
	state.LastRunAt = config.Str(now)
	state.LastStatus = config.Str(status)
	state.LastExitCode = config.Int(exitCode)
	state.LastDurationSeconds = config.Int(duration)
	if status == "OK" {
		state.LastUpdate = config.Str(now)
	}
	if err := state.Write(); err != nil {
		logs.Append("[update] failed to persist state: %v", err)
	}
}

// runCommand executes one update step, appending its transcript to the day's
// log. The exit code is returned so the caller can report it verbatim.
func runCommand(command []string, logPath string, streamOutput bool) (int, error) {
	handle, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return 1, err
	}
	defer handle.Close()

	header := fmt.Sprintf("\n$ %s\n", shellJoin(command))
	handle.WriteString(header)

	var output io.Writer = handle
	if streamOutput {
		os.Stdout.WriteString(header)
		output = io.MultiWriter(handle, os.Stdout)
	}

	ctx, cancel := context.WithTimeout(context.Background(), updateTimeout)
	defer cancel()

	process := exec.CommandContext(ctx, command[0], command[1:]...)
	process.Stdout = output
	process.Stderr = output
	runErr := process.Run()

	if ctx.Err() == context.DeadlineExceeded {
		return 1, fmt.Errorf("update step timed out after %s", updateTimeout)
	}
	if runErr != nil {
		var exitError *exec.ExitError
		if ok := asExitError(runErr, &exitError); ok {
			return exitError.ExitCode(), nil
		}
		return 1, runErr
	}
	return 0, nil
}
