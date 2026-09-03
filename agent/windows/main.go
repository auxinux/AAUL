//go:build windows

// Command aaul-agent is the AAUL agent for Windows.
//
// One executable plays three roles:
//
//	aaul-agent.exe                    started by the SCM — runs as a service
//	aaul-agent.exe run --console      runs the same loop in the foreground
//	aaul-agent.exe <subcommand>       the local CLI (status, logs, update, ...)
//
// It replaces a Python agent whose installer spent 260 lines of PowerShell
// trying to produce a working interpreter on a fresh Windows machine. A single
// static binary has nothing to bootstrap.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/svc"

	"aaul-agent/internal/config"
	"aaul-agent/internal/logs"
	"aaul-agent/internal/osupdate"
	"aaul-agent/internal/poller"
	"aaul-agent/internal/selfupdate"
	"aaul-agent/internal/service"
	"aaul-agent/internal/sysinfo"
	"aaul-agent/internal/version"
)

func main() {
	// A binary left behind by the last self-update is only safe to delete once
	// the new one has demonstrably started.
	selfupdate.CleanupPrevious()

	arguments := os.Args[1:]
	if len(arguments) == 0 {
		runWithoutSubcommand()
		return
	}

	switch arguments[0] {
	case "run":
		commandRun(arguments[1:])
	case "install-service":
		exitOnError(commandInstallService())
	case "uninstall-service":
		exitOnError(service.Remove())
	case "start":
		exitOnError(service.Start())
	case "stop":
		exitOnError(service.Stop())
	case "restart":
		exitOnError(service.RequestRestart())
	case "version":
		fmt.Println(version.Version)
	case "status":
		exitOnError(commandStatus())
	case "check-in":
		exitOnError(commandCheckIn())
	case "logs":
		exitOnError(commandLogs(arguments[1:]))
	case "update":
		commandUpdate()
	case "info":
		exitOnError(commandInfo())
	case "uninstall":
		exitOnError(commandUninstall(arguments[1:]))
	case "config":
		exitOnError(commandConfig(arguments[1:]))
	case "help", "-h", "--help":
		usage(os.Stdout)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", arguments[0])
		usage(os.Stderr)
		os.Exit(2)
	}
}

// runWithoutSubcommand decides whether this process was started by the service
// control manager or by a human at a prompt.
func runWithoutSubcommand() {
	isService, err := service.IsWindowsService()
	if err != nil {
		fmt.Fprintf(os.Stderr, "could not determine the execution context: %v\n", err)
		os.Exit(1)
	}
	if isService {
		runAsService()
		return
	}
	// Started from a console with no arguments: show the usage rather than
	// silently becoming a daemon.
	usage(os.Stdout)
}

func usage(output *os.File) {
	fmt.Fprintf(output, `aaul-agent %s — AAUL agent for Windows

Usage:
  aaul-agent                       run as a Windows service (started by the SCM)
  aaul-agent run --console         run the poll loop in this console
  aaul-agent run --once            send a single poll and exit

  aaul-agent install-service       register and configure the Windows service
  aaul-agent uninstall-service     remove the Windows service
  aaul-agent start|stop|restart    control the Windows service

  aaul-agent version               print the agent version
  aaul-agent status                print the local status as JSON
  aaul-agent check-in              send an immediate heartbeat
  aaul-agent info                  print the full host inventory as JSON
  aaul-agent logs [--lines N]      print the latest agent log
  aaul-agent update                run operating-system updates now
  aaul-agent uninstall [--yes]     remove the agent from this machine

  aaul-agent config show           print the local configuration
  aaul-agent config set-dashboard <url>
`, version.Version)
}

func exitOnError(err error) {
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

// --------------------------------------------------------------------------
//  Service and console modes
// --------------------------------------------------------------------------

func commandRun(arguments []string) {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	console := flags.Bool("console", false, "run the poll loop in this console instead of as a service")
	once := flags.Bool("once", false, "send a single poll and exit")
	flags.Parse(arguments)

	if *once {
		cfg, err := config.Load()
		exitOnError(err)
		exitOnError(poller.PollOnce(cfg))
		fmt.Println("poll sent")
		return
	}

	if *console {
		runInConsole()
		return
	}
	runAsService()
}

// runInConsole is the debugging mode: the same loop, in the foreground, with
// the log echoed to stdout so a failure is visible immediately instead of
// having to be dug out of a file.
func runInConsole() {
	fmt.Printf("aaul-agent %s — console mode, Ctrl+C to stop\n", version.Version)
	logs.EchoToStdout(true)
	loop := poller.New()
	loop.Run()
}

func runAsService() {
	exitOnError(svc.Run(service.Name, &serviceHandler{}))
}

// serviceHandler adapts the poll loop to the Windows service control protocol.
type serviceHandler struct{}

func (h *serviceHandler) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const accepted = svc.AcceptStop | svc.AcceptShutdown

	changes <- svc.Status{State: svc.StartPending}
	loop := poller.New()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		loop.Run()
	}()
	changes <- svc.Status{State: svc.Running, Accepts: accepted}

	for {
		select {
		case <-finished:
			// The loop unwound on its own: either the agent uninstalled itself
			// or a command asked for a restart with a new binary.
			changes <- svc.Status{State: svc.StopPending}
			if loop.RestartRequested() {
				if err := service.RequestRestart(); err != nil {
					logs.Append("[service] could not request a restart: %v", err)
				}
			}
			if loop.Uninstalled() {
				finishUninstall()
			}
			return false, 0

		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				logs.Append("[service] stop requested")
				changes <- svc.Status{State: svc.StopPending}
				loop.Stop()
				<-finished
				return false, 0
			default:
				changes <- svc.Status{State: svc.Running, Accepts: accepted}
			}
		}
	}
}

// finishUninstall hands the teardown to a detached process.
//
// Stopping, deregistering and deleting all have to happen after this process
// has exited, so none of it can be done here -- see ScheduleSelfRemoval.
func finishUninstall() {
	if err := service.ScheduleSelfRemoval(); err != nil {
		logs.Append("[uninstall] could not schedule the removal: %v", err)
	}
}

// --------------------------------------------------------------------------
//  Installation
// --------------------------------------------------------------------------

// commandInstallService registers the service against the binary's own
// location, so the installer only has to drop the file and call this.
func commandInstallService() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return err
	}

	if err := config.EnsureRuntimeDirs(); err != nil {
		return err
	}
	if err := service.Install(executable); err != nil {
		return err
	}
	if err := service.AddToSystemPath(filepath.Dir(executable)); err != nil {
		// Not fatal: the service is installed, only the CLI shortcut is missing.
		fmt.Fprintf(os.Stderr, "warning: could not add %s to PATH: %v\n", filepath.Dir(executable), err)
	}

	fmt.Printf("service %q installed (%s)\n", service.Name, executable)
	return nil
}

func commandUninstall(arguments []string) error {
	flags := flag.NewFlagSet("uninstall", flag.ExitOnError)
	yes := flags.Bool("yes", false, "do not ask for confirmation")
	flags.Parse(arguments)

	if !*yes {
		fmt.Printf("This removes the agent, its service and %s.\nRe-run with --yes to confirm.\n",
			config.RuntimeDir())
		return nil
	}

	if err := service.RemoveFromSystemPath(config.BinDir()); err != nil {
		fmt.Fprintf(os.Stderr, "warning: could not clean PATH: %v\n", err)
	}
	if err := service.Remove(); err != nil {
		return err
	}
	if err := service.ScheduleSelfRemoval(); err != nil {
		return err
	}
	fmt.Println("agent removed")
	return nil
}

// --------------------------------------------------------------------------
//  Local CLI
// --------------------------------------------------------------------------

func commandStatus() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	state := config.ReadState()
	return printJSON(map[string]any{
		"agentId":             cfg.AgentID,
		"displayName":         cfg.DisplayName,
		"dashboardUrl":        cfg.DashboardURL,
		"agentVersion":        version.Version,
		"pollIntervalSeconds": cfg.PollIntervalSeconds,
		"schedule":            cfg.Schedule,
		"service":             service.State(),
		"lastPoll":            state.LastPoll,
		"lastRunAt":           state.LastRunAt,
		"lastStatus":          state.LastStatus,
		"lastExitCode":        state.LastExitCode,
		"lastDurationSeconds": state.LastDurationSeconds,
		"rebootRequired":      sysinfo.RebootRequired(),
	})
}

func commandCheckIn() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := poller.PollOnce(cfg); err != nil {
		return err
	}
	fmt.Println("check-in sent")
	return nil
}

func commandInfo() error {
	return printJSON(sysinfo.Collect())
}

func commandLogs(arguments []string) error {
	flags := flag.NewFlagSet("logs", flag.ExitOnError)
	lines := flags.Int("lines", 200, "number of trailing lines to print")
	flags.Parse(arguments)

	entries := logs.List()
	if len(entries) == 0 {
		fmt.Println("no log file yet")
		return nil
	}
	latest := entries[len(entries)-1]
	content, err := logs.Read(latest.Name, logs.DefaultMaxReadBytes)
	if err != nil {
		return err
	}

	all := strings.Split(strings.TrimRight(content.Content, "\n"), "\n")
	if *lines > 0 && len(all) > *lines {
		all = all[len(all)-*lines:]
	}
	fmt.Printf("== %s ==\n%s\n", latest.Name, strings.Join(all, "\n"))
	return nil
}

// commandUpdate runs the OS update in the foreground with its output streamed,
// which is what makes it useful to run by hand.
func commandUpdate() {
	result := osupdate.Run(true)
	fmt.Printf("\nstatus=%s exit=%d duration=%ds\nlog: %s\n",
		result.Status, result.ExitCode, result.Duration, result.LogPath)
	if result.Status != "OK" {
		if result.Message != "" {
			fmt.Fprintln(os.Stderr, result.Message)
		}
		os.Exit(result.ExitCode)
	}
}

func commandConfig(arguments []string) error {
	if len(arguments) == 0 {
		return fmt.Errorf("usage: aaul-agent config show | set-dashboard <url>")
	}
	switch arguments[0] {
	case "show":
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		// The API token is a credential; printing it would leak it into shell
		// history and screenshots.
		return printJSON(map[string]any{
			"agentId":             cfg.AgentID,
			"displayName":         cfg.DisplayName,
			"dashboardUrl":        cfg.DashboardURL,
			"pollIntervalSeconds": cfg.PollIntervalSeconds,
			"schedule":            cfg.Schedule,
			"agentApiToken":       "<redacted>",
		})
	case "set-dashboard":
		if len(arguments) < 2 {
			return fmt.Errorf("usage: aaul-agent config set-dashboard <url>")
		}
		url := strings.TrimRight(arguments[1], "/")
		if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
			return fmt.Errorf("the dashboard URL must start with http:// or https://")
		}
		cfg, err := config.Load()
		if err != nil {
			return err
		}
		cfg.DashboardURL = url
		if err := cfg.Save(); err != nil {
			return err
		}
		fmt.Printf("dashboard URL set to %s\n", url)
		return nil
	default:
		return fmt.Errorf("unknown config command %q", arguments[0])
	}
}

func printJSON(value any) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
