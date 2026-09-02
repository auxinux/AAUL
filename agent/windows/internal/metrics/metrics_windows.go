//go:build windows

// Package metrics collects the cheap vital signs that ride along on every poll.
//
// It is deliberately separate from package sysinfo: this payload is sent every
// 15 seconds by default, so it stays flat, under a kilobyte, and free of any
// subprocess. The JSON shape matches the Python agent's collect_metrics()
// (agent/app/lib/metrics.py:240) because the dashboard renders it directly.
package metrics

import (
	"math"
	"runtime"
	"time"

	"aaul-agent/internal/logs"
	"aaul-agent/internal/winapi"
)

// cpuSampleWindow is how long CPUPercent blocks to get a usable delta between
// two readings of the cumulative counters.
const cpuSampleWindow = 200 * time.Millisecond

// Memory is physical RAM usage. Every field is nullable so a failed probe
// degrades to `null` in the UI instead of a misleading zero.
type Memory struct {
	TotalBytes     *uint64  `json:"totalBytes"`
	UsedBytes      *uint64  `json:"usedBytes"`
	AvailableBytes *uint64  `json:"availableBytes"`
	Percent        *float64 `json:"percent"`
}

// Usage is one filesystem's occupancy.
type Usage struct {
	Mount      string  `json:"mount"`
	TotalBytes uint64  `json:"totalBytes"`
	UsedBytes  uint64  `json:"usedBytes"`
	FreeBytes  uint64  `json:"freeBytes"`
	Percent    float64 `json:"percent"`
}

// Disk carries the system drive plus the fullest one. `root` is what admins
// watch; `busiest` is what actually pages you at 3 a.m. when a data volume
// fills up while C: still looks fine.
type Disk struct {
	Root    *Usage `json:"root"`
	Busiest *Usage `json:"busiest"`
}

// Metrics is the full vital-signs payload.
type Metrics struct {
	CollectedAt string   `json:"collectedAt"`
	CPUPercent  *float64 `json:"cpuPercent"`
	// LoadAverage has no Windows equivalent. It stays in the payload as null so
	// the dashboard can keep one schema for every platform.
	LoadAverage any    `json:"loadAverage"`
	CPUCount    int    `json:"cpuCount"`
	Memory      Memory `json:"memory"`
	// Swap is reported as null on Windows on purpose. The page file is a commit
	// store, not a swap device, and GlobalMemoryStatusEx's page-file figures
	// include physical RAM — charting them next to Linux swap would compare two
	// different things.
	Swap          any  `json:"swap"`
	Disk          Disk `json:"disk"`
	ProcessCount  *int `json:"processCount"`
	LoggedInUsers *int `json:"loggedInUsers"`
}

func round1(value float64) float64 {
	return math.Round(value*10) / 10
}

// Collect gathers every probe. Individual failures degrade to null rather than
// propagating: a metric must never be the reason a poll fails.
func Collect() Metrics {
	result := Metrics{
		CollectedAt: logs.UTCNowISO(),
		CPUCount:    runtime.NumCPU(),
	}

	if percent, err := winapi.CPUPercent(cpuSampleWindow); err == nil {
		rounded := round1(percent)
		result.CPUPercent = &rounded
	}

	result.Memory = collectMemory()
	result.Disk = collectDisk()

	if count, err := winapi.ProcessCount(); err == nil {
		result.ProcessCount = &count
	}
	if count, err := winapi.LoggedInUsers(); err == nil {
		result.LoggedInUsers = &count
	}

	return result
}

func collectMemory() Memory {
	info, err := winapi.Memory()
	if err != nil || info.TotalBytes == 0 {
		return Memory{}
	}
	total, used, available := info.TotalBytes, info.UsedBytes, info.AvailableBytes
	percent := round1(100 * float64(used) / float64(total))
	return Memory{
		TotalBytes:     &total,
		UsedBytes:      &used,
		AvailableBytes: &available,
		Percent:        &percent,
	}
}

func collectDisk() Disk {
	result := Disk{}
	for _, drive := range winapi.FixedDrives() {
		if drive.SizeBytes == 0 {
			continue
		}
		usage := Usage{
			Mount:      drive.Device + `\`,
			TotalBytes: drive.SizeBytes,
			UsedBytes:  drive.UsedBytes,
			FreeBytes:  drive.AvailBytes,
			Percent:    round1(100 * float64(drive.UsedBytes) / float64(drive.SizeBytes)),
		}
		entry := usage
		if usage.Mount == `C:\` {
			result.Root = &entry
		}
		// Unlike the Python agent, which only ever looked at C:, every fixed
		// volume is a candidate for `busiest` — a full D: is exactly the case
		// this field exists to surface.
		if result.Busiest == nil || usage.Percent > result.Busiest.Percent {
			result.Busiest = &entry
		}
	}
	return result
}
