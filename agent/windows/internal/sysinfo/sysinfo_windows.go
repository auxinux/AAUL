//go:build windows

// Package sysinfo collects the full host inventory returned by the FETCH_INFO
// command.
//
// Unlike package metrics, this runs on demand rather than on every poll, so it
// can afford to call winget. Everything else is read from the registry and the
// Win32 API — the Python agent it replaces shelled out to PowerShell and
// ConvertTo-Json five separate times for the same result.
//
// The JSON shape matches collect_system_info() (agent/app/lib/system_info.py:979);
// the dashboard renders these keys directly.
package sysinfo

import (
	"fmt"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/windows/registry"

	"aaul-agent/internal/logs"
	"aaul-agent/internal/packages"
	"aaul-agent/internal/winapi"
)

// OS identifies the operating system.
type OS struct {
	Name       string `json:"name"`
	Version    string `json:"version"`
	Codename   string `json:"codename"`
	PrettyName string `json:"prettyName"`
}

// CPU describes the processor and its current load.
type CPU struct {
	Model        string  `json:"model"`
	Cores        int     `json:"cores"`
	Threads      int     `json:"threads"`
	UsagePercent float64 `json:"usagePercent"`
}

// Memory is physical RAM, in bytes.
type Memory struct {
	TotalBytes     uint64 `json:"totalBytes"`
	AvailableBytes uint64 `json:"availableBytes"`
	UsedBytes      uint64 `json:"usedBytes"`
}

// Disk is one fixed volume.
type Disk struct {
	Device     string `json:"device"`
	Mount      string `json:"mount"`
	FSType     string `json:"fsType"`
	SizeBytes  uint64 `json:"sizeBytes"`
	UsedBytes  uint64 `json:"usedBytes"`
	AvailBytes uint64 `json:"availBytes"`
}

// Info is the complete inventory payload.
type Info struct {
	CollectedAt    string   `json:"collectedAt"`
	OS             OS       `json:"os"`
	PackageManager string   `json:"packageManager"`
	CPU            CPU      `json:"cpu"`
	Memory         Memory   `json:"memory"`
	GPU            []string `json:"gpu"`
	IPs            []string `json:"ips"`
	Disks          []Disk   `json:"disks"`
	Repositories   []string `json:"repositories"`
	// Nullable on purpose: a machine whose winget cannot be queried must not
	// report "0 Installed", which the dashboard renders identically to a
	// machine that genuinely has no packages. null makes it show "no info".
	PackagesInstalled *int  `json:"packagesInstalled"`
	UptimeSeconds     int64 `json:"uptimeSeconds"`
	RebootRequired    bool  `json:"rebootRequired"`
}

// cpuSampleWindow matches the metrics sampler: long enough for a meaningful
// delta, short enough not to stall a command.
const cpuSampleWindow = 200 * time.Millisecond

// Collect gathers the whole inventory. Individual probes degrade to zero values
// rather than failing the command: a partial inventory is more useful to an
// operator than none.
func Collect() Info {
	info := Info{
		CollectedAt:    logs.UTCNowISO(),
		OS:             GetOS(),
		PackageManager: packages.Manager,
		CPU:            getCPU(),
		Memory:         getMemory(),
		GPU:            getGPU(),
		IPs:            winapi.IPAddresses(),
		Disks:          getDisks(),
		Repositories:   getRepositories(),
		UptimeSeconds:  winapi.UptimeSeconds(),
		RebootRequired: RebootRequired(),
	}
	info.PackagesInstalled = getPackageCount()
	return info
}

// --------------------------------------------------------------------------
//  Operating system
// --------------------------------------------------------------------------

const currentVersionKey = `SOFTWARE\Microsoft\Windows NT\CurrentVersion`

// buildWindows11 is the first build number that is Windows 11. The registry
// still reports ProductName as "Windows 10 ..." on Windows 11, a known quirk
// Microsoft never fixed, so the build number is the only reliable signal.
const buildWindows11 = 22000

// GetOS reads the OS identity from the registry.
func GetOS() OS {
	result := OS{Name: "Windows", PrettyName: "Windows"}

	key, err := registry.OpenKey(registry.LOCAL_MACHINE, currentVersionKey, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return result
	}
	defer key.Close()

	productName, _, _ := key.GetStringValue("ProductName")
	displayVersion, _, _ := key.GetStringValue("DisplayVersion")
	currentBuild, _, _ := key.GetStringValue("CurrentBuild")
	updateBuildRevision, _, _ := key.GetIntegerValue("UBR")

	build := 0
	fmt.Sscanf(currentBuild, "%d", &build)

	if build >= buildWindows11 {
		productName = strings.Replace(productName, "Windows 10", "Windows 11", 1)
	}
	if productName == "" {
		productName = "Windows"
	}

	result.Version = fmt.Sprintf("10.0.%s", currentBuild)
	if updateBuildRevision > 0 {
		result.Version = fmt.Sprintf("%s.%d", result.Version, updateBuildRevision)
	}
	// DisplayVersion ("24H2") is the Windows equivalent of a Linux release
	// codename, which is the field the dashboard shows next to the OS name.
	result.Codename = displayVersion
	result.PrettyName = strings.TrimSpace(productName + " " + displayVersion)
	return result
}

// rebootPendingKeys are the three places Windows records that a restart is
// owed. Any one of them is enough.
var rebootPendingKeys = []struct {
	root registry.Key
	path string
}{
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`},
	{registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`},
}

// RebootRequired reports whether the host is known to owe a restart.
//
// The Python agent only checked the Windows Update key, which misses servicing
// operations and pending file renames — the two cases where a machine is left
// in a half-patched state without Windows Update having anything to say.
func RebootRequired() bool {
	for _, entry := range rebootPendingKeys {
		key, err := registry.OpenKey(entry.root, entry.path, registry.QUERY_VALUE|registry.WOW64_64KEY)
		if err == nil {
			key.Close()
			return true
		}
	}

	sessionManager, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`SYSTEM\CurrentControlSet\Control\Session Manager`, registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return false
	}
	defer sessionManager.Close()
	pending, _, err := sessionManager.GetStringsValue("PendingFileRenameOperations")
	return err == nil && len(pending) > 0
}

// --------------------------------------------------------------------------
//  Hardware
// --------------------------------------------------------------------------

func getCPU() CPU {
	result := CPU{Threads: runtime.NumCPU()}

	key, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`HARDWARE\DESCRIPTION\System\CentralProcessor\0`, registry.QUERY_VALUE)
	if err == nil {
		defer key.Close()
		if name, _, err := key.GetStringValue("ProcessorNameString"); err == nil {
			result.Model = strings.TrimSpace(name)
		}
	}
	if result.Model == "" {
		result.Model = "Unknown"
	}

	if cores, err := winapi.PhysicalCoreCount(); err == nil {
		result.Cores = cores
	} else {
		// Better to report logical processors than zero cores.
		result.Cores = result.Threads
	}

	if percent, err := winapi.CPUPercent(cpuSampleWindow); err == nil {
		result.UsagePercent = float64(int(percent*10+0.5)) / 10
	}
	return result
}

func getMemory() Memory {
	info, err := winapi.Memory()
	if err != nil {
		return Memory{}
	}
	return Memory{
		TotalBytes:     info.TotalBytes,
		AvailableBytes: info.AvailableBytes,
		UsedBytes:      info.UsedBytes,
	}
}

// displayAdapterClass is the device setup class GUID for display adapters.
// Each installed adapter gets a numbered subkey under it.
const displayAdapterClass = `SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}`

func getGPU() []string {
	names := []string{}
	classKey, err := registry.OpenKey(registry.LOCAL_MACHINE, displayAdapterClass,
		registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE|registry.WOW64_64KEY)
	if err != nil {
		return names
	}
	defer classKey.Close()

	subKeys, err := classKey.ReadSubKeyNames(-1)
	if err != nil {
		return names
	}
	seen := map[string]bool{}
	for _, name := range subKeys {
		// Only the numbered instance keys describe an adapter; siblings such as
		// "Configuration" and "Properties" do not.
		if len(name) != 4 || strings.Trim(name, "0123456789") != "" {
			continue
		}
		adapter, err := registry.OpenKey(registry.LOCAL_MACHINE,
			displayAdapterClass+`\`+name, registry.QUERY_VALUE|registry.WOW64_64KEY)
		if err != nil {
			continue
		}
		description, _, err := adapter.GetStringValue("DriverDesc")
		adapter.Close()
		description = strings.TrimSpace(description)
		if err != nil || description == "" || seen[description] {
			continue
		}
		seen[description] = true
		names = append(names, description)
	}
	sort.Strings(names)
	return names
}

func getDisks() []Disk {
	disks := []Disk{}
	for _, drive := range winapi.FixedDrives() {
		disks = append(disks, Disk{
			Device: drive.Device,
			// The Python agent reported DeviceID for both fields; keeping that
			// keeps the dashboard's disk table identical.
			Mount:      drive.Device,
			FSType:     drive.FSType,
			SizeBytes:  drive.SizeBytes,
			UsedBytes:  drive.UsedBytes,
			AvailBytes: drive.AvailBytes,
		})
	}
	return disks
}

// --------------------------------------------------------------------------
//  Packages
// --------------------------------------------------------------------------

func getRepositories() []string {
	sources, err := packages.Sources()
	if err != nil {
		return []string{}
	}
	return sources
}

func getPackageCount() *int {
	result, err := packages.ListInstalled()
	if err != nil {
		logs.Append("[info] could not count installed packages: %v", err)
		return nil
	}
	return &result.Count
}
