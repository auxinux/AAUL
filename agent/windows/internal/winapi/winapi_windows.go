//go:build windows

// Package winapi wraps the handful of Win32 calls the agent needs that
// golang.org/x/sys/windows does not already expose.
//
// It exists so the agent can collect metrics and inventory without spawning a
// process. The Python agent it replaces shelled out to PowerShell for CPU usage
// on every single poll — roughly 5 700 interpreter launches a day at a 15 s
// interval. These calls cost microseconds instead.
package winapi

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procGetSystemTimes                   = kernel32.NewProc("GetSystemTimes")
	procGetTickCount64                   = kernel32.NewProc("GetTickCount64")
	procGlobalMemoryStatusEx             = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetLogicalProcessorInformationEx = kernel32.NewProc("GetLogicalProcessorInformationEx")
)

// UptimeSeconds returns how long the machine has been running.
func UptimeSeconds() int64 {
	milliseconds, _, _ := procGetTickCount64.Call()
	return int64(milliseconds) / 1000
}

// --------------------------------------------------------------------------
//  CPU
// --------------------------------------------------------------------------

type systemTimes struct {
	idle   uint64
	kernel uint64
	user   uint64
}

func filetimeToUint64(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

func getSystemTimes() (systemTimes, error) {
	var idle, kernel, user windows.Filetime
	ret, _, err := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)),
	)
	if ret == 0 {
		return systemTimes{}, err
	}
	return systemTimes{
		idle:   filetimeToUint64(idle),
		kernel: filetimeToUint64(kernel),
		user:   filetimeToUint64(user),
	}, nil
}

// CPUPercent samples system-wide busy time over the given window.
//
// GetSystemTimes reports cumulative counters, so a single reading says nothing:
// two readings are needed. `kernel` already includes `idle`, which is why total
// time is kernel+user and busy time is total-idle.
func CPUPercent(window time.Duration) (float64, error) {
	first, err := getSystemTimes()
	if err != nil {
		return 0, err
	}
	time.Sleep(window)
	second, err := getSystemTimes()
	if err != nil {
		return 0, err
	}

	idleDelta := second.idle - first.idle
	totalDelta := (second.kernel - first.kernel) + (second.user - first.user)
	if totalDelta == 0 {
		return 0, fmt.Errorf("no CPU time elapsed over %s", window)
	}
	busy := float64(totalDelta-idleDelta) / float64(totalDelta) * 100
	if busy < 0 {
		busy = 0
	}
	if busy > 100 {
		busy = 100
	}
	return busy, nil
}

// --------------------------------------------------------------------------
//  Memory
// --------------------------------------------------------------------------

type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// MemoryInfo is physical RAM usage in bytes.
type MemoryInfo struct {
	TotalBytes     uint64
	AvailableBytes uint64
	UsedBytes      uint64
}

// Memory returns physical memory usage.
func Memory() (MemoryInfo, error) {
	status := memoryStatusEx{}
	status.Length = uint32(unsafe.Sizeof(status))
	ret, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	if ret == 0 {
		return MemoryInfo{}, err
	}
	return MemoryInfo{
		TotalBytes:     status.TotalPhys,
		AvailableBytes: status.AvailPhys,
		UsedBytes:      status.TotalPhys - status.AvailPhys,
	}, nil
}

// --------------------------------------------------------------------------
//  Processors
// --------------------------------------------------------------------------

// relationProcessorCore selects physical-core records from
// GetLogicalProcessorInformationEx.
const relationProcessorCore = 0

// PhysicalCoreCount counts physical cores, as opposed to runtime.NumCPU() which
// counts logical processors (hyper-threads included).
func PhysicalCoreCount() (int, error) {
	var size uint32
	ret, _, _ := procGetLogicalProcessorInformationEx.Call(
		uintptr(relationProcessorCore), 0, uintptr(unsafe.Pointer(&size)))
	if ret != 0 || size == 0 {
		return 0, fmt.Errorf("GetLogicalProcessorInformationEx did not report a buffer size")
	}

	buffer := make([]byte, size)
	ret, _, err := procGetLogicalProcessorInformationEx.Call(
		uintptr(relationProcessorCore),
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return 0, err
	}

	// The buffer is a packed sequence of variable-length records; each starts
	// with {Relationship uint32, Size uint32} and Size is how far to jump.
	count := 0
	for offset := uint32(0); offset+8 <= size; {
		relationship := *(*uint32)(unsafe.Pointer(&buffer[offset]))
		recordSize := *(*uint32)(unsafe.Pointer(&buffer[offset+4]))
		if recordSize == 0 {
			break
		}
		if relationship == relationProcessorCore {
			count++
		}
		offset += recordSize
	}
	if count == 0 {
		return 0, fmt.Errorf("no processor core records returned")
	}
	return count, nil
}

// --------------------------------------------------------------------------
//  Processes and sessions
// --------------------------------------------------------------------------

// ProcessCount returns the number of running processes.
func ProcessCount() (int, error) {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snapshot)

	entry := windows.ProcessEntry32{}
	entry.Size = uint32(unsafe.Sizeof(entry))
	if err := windows.Process32First(snapshot, &entry); err != nil {
		return 0, err
	}
	count := 0
	for {
		count++
		if err := windows.Process32Next(snapshot, &entry); err != nil {
			break
		}
	}
	return count, nil
}

// LoggedInUsers counts active interactive sessions (console and RDP).
//
// Disconnected and listening sessions are excluded: an operator asking "is
// anyone on this box right now" does not want the idle RDP listener counted.
func LoggedInUsers() (int, error) {
	var sessions *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &sessions, &count); err != nil {
		return 0, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(sessions)))

	list := unsafe.Slice(sessions, count)
	active := 0
	for _, session := range list {
		if session.State == windows.WTSActive {
			active++
		}
	}
	return active, nil
}
