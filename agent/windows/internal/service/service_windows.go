//go:build windows

// Package service registers and runs the agent as a native Windows service.
//
// The Python agent it replaces ran from a SYSTEM scheduled task, because
// turning a Python script into a real service is awkward. A Go binary can
// implement the service control protocol directly, which is what an operator
// expects: the agent shows up in services.msc, starts at boot before anyone
// logs in, and is restarted by the SCM if it ever dies.
package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"aaul-agent/internal/config"
	"aaul-agent/internal/logs"
)

// Service identity as seen in services.msc and sc.exe.
const (
	Name        = "AgentAutoUpdate"
	DisplayName = "Agent Auto Update"
	Description = "Applies operating-system updates and reports host state to the AAUL dashboard."
)

// BinaryName is the executable the installer places under the runtime bin
// directory.
const BinaryName = "aaul-agent.exe"

// BinaryPath is where the service executable lives.
func BinaryPath() string {
	return filepath.Join(config.BinDir(), BinaryName)
}

// IsWindowsService reports whether this process was started by the SCM rather
// than from a console.
func IsWindowsService() (bool, error) {
	return svc.IsWindowsService()
}

// Install registers the service and points it at binaryPath.
func Install(binaryPath string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("service manager unavailable (administrator rights required): %w", err)
	}
	defer manager.Disconnect()

	// Re-running the installer over an existing install must not fail.
	if existing, err := manager.OpenService(Name); err == nil {
		existing.Close()
		if err := Remove(); err != nil {
			return fmt.Errorf("removing the previous service failed: %w", err)
		}
	}

	service, err := manager.CreateService(Name, binaryPath, mgr.Config{
		DisplayName: DisplayName,
		Description: Description,
		StartType:   mgr.StartAutomatic,
		// LocalSystem is required: the agent installs updates and writes under
		// %PROGRAMDATA%, neither of which a restricted account can do.
		ServiceStartName: "LocalSystem",
	})
	if err != nil {
		return fmt.Errorf("creating the service failed: %w", err)
	}
	defer service.Close()

	// Restart forever, one minute apart. An agent that gave up after three
	// crashes would go silently missing from the fleet view.
	recovery := []mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: time.Minute},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
		{Type: mgr.ServiceRestart, Delay: time.Minute},
	}
	if err := service.SetRecoveryActions(recovery, uint32((24 * time.Hour).Seconds())); err != nil {
		logs.Append("[service] could not set recovery actions: %v", err)
	}

	return nil
}

// Remove stops and deletes the service.
func Remove() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(Name)
	if err != nil {
		// Already gone: uninstall must be idempotent.
		return nil
	}
	defer service.Close()

	if status, err := service.Query(); err == nil && status.State != svc.Stopped {
		if _, err := service.Control(svc.Stop); err == nil {
			waitForState(service, svc.Stopped, 30*time.Second)
		}
	}
	return service.Delete()
}

// Start starts the service if it is not already running.
func Start() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(Name)
	if err != nil {
		return fmt.Errorf("service %s is not installed", Name)
	}
	defer service.Close()

	if status, err := service.Query(); err == nil && status.State == svc.Running {
		return nil
	}
	return service.Start()
}

// Stop stops the service and waits for it to settle.
func Stop() error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(Name)
	if err != nil {
		return nil
	}
	defer service.Close()

	if _, err := service.Control(svc.Stop); err != nil {
		return err
	}
	waitForState(service, svc.Stopped, 30*time.Second)
	return nil
}

// State returns the current service state as a human-readable word, or
// "not-installed".
func State() string {
	manager, err := mgr.Connect()
	if err != nil {
		return "unknown"
	}
	defer manager.Disconnect()

	service, err := manager.OpenService(Name)
	if err != nil {
		return "not-installed"
	}
	defer service.Close()

	status, err := service.Query()
	if err != nil {
		return "unknown"
	}
	switch status.State {
	case svc.Running:
		return "running"
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "starting"
	case svc.StopPending:
		return "stopping"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}

func waitForState(service *mgr.Service, want svc.State, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		status, err := service.Query()
		if err != nil || status.State == want {
			return
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// RequestRestart restarts the service from a detached helper.
//
// The agent cannot restart itself in place: it has to be gone before the SCM
// will start it again, and the new binary has to be the one that comes back.
// A short-lived cmd.exe does the stop/start from outside, so the wait happens
// after this process has exited.
func RequestRestart() error {
	script := fmt.Sprintf(
		`sc stop %s & ping 127.0.0.1 -n 6 >NUL & sc start %s`, Name, Name)
	command := exec.Command("cmd.exe", "/c", script)
	command.SysProcAttr = detachedProcess()
	return command.Start()
}

// ScheduleSelfRemoval deletes the runtime directory after this process exits.
//
// The agent cannot delete the directory holding its own running executable, so
// a detached cmd.exe waits a couple of seconds and then removes everything,
// including itself.
func ScheduleSelfRemoval() error {
	scriptPath := filepath.Join(os.TempDir(), "agentautoupdate-uninstall.cmd")
	script := fmt.Sprintf("@echo off\r\n"+
		"ping 127.0.0.1 -n 4 >NUL\r\n"+
		"rmdir /S /Q \"%s\"\r\n"+
		"del /F /Q \"%%~f0\"\r\n", config.RuntimeDir())
	if err := os.WriteFile(scriptPath, []byte(script), 0o600); err != nil {
		return err
	}
	command := exec.Command("cmd.exe", "/c", scriptPath)
	command.SysProcAttr = detachedProcess()
	return command.Start()
}

func detachedProcess() *windows.SysProcAttr {
	return &windows.SysProcAttr{
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
		HideWindow:    true,
	}
}

// --------------------------------------------------------------------------
//  PATH registration
// --------------------------------------------------------------------------

const environmentKey = `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`

// AddToSystemPath puts the agent's bin directory on the machine PATH so
// `aaul-agent` works from any administrator shell. There is no wrapper .cmd to
// maintain: the service binary is also the CLI.
func AddToSystemPath(directory string) error {
	return updateSystemPath(func(entries []string) []string {
		for _, entry := range entries {
			if equalPath(entry, directory) {
				return entries
			}
		}
		return append(entries, directory)
	})
}

// RemoveFromSystemPath undoes AddToSystemPath.
func RemoveFromSystemPath(directory string) error {
	return updateSystemPath(func(entries []string) []string {
		kept := make([]string, 0, len(entries))
		for _, entry := range entries {
			if !equalPath(entry, directory) {
				kept = append(kept, entry)
			}
		}
		return kept
	})
}
