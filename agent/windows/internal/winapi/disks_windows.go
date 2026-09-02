//go:build windows

package winapi

import (
	"sort"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Drive is one fixed volume, in the shape the dashboard expects.
type Drive struct {
	// Device is the drive letter with its colon and no trailing separator
	// ("C:"), matching the DeviceID the Python agent read from Win32_LogicalDisk.
	Device     string
	FSType     string
	SizeBytes  uint64
	UsedBytes  uint64
	AvailBytes uint64
}

// FixedDrives enumerates local fixed volumes.
//
// Only DRIVE_FIXED is reported: mapped network shares and removable media are
// not this machine's storage, and a disconnected share would otherwise show up
// as a mysteriously full disk.
func FixedDrives() []Drive {
	drives := []Drive{}

	buffer := make([]uint16, 512)
	length, err := windows.GetLogicalDriveStrings(uint32(len(buffer)), &buffer[0])
	if err != nil || length == 0 {
		return drives
	}

	for _, root := range splitNullSeparated(buffer[:length]) {
		if root == "" {
			continue
		}
		rootPtr, err := windows.UTF16PtrFromString(root)
		if err != nil {
			continue
		}
		if windows.GetDriveType(rootPtr) != windows.DRIVE_FIXED {
			continue
		}

		var freeForCaller, total, totalFree uint64
		if err := windows.GetDiskFreeSpaceEx(rootPtr, &freeForCaller, &total, &totalFree); err != nil {
			continue
		}
		if total == 0 {
			continue
		}

		drives = append(drives, Drive{
			Device: strings.TrimSuffix(root, `\`),
			// The dashboard shows the filesystem label; NTFS is the sane
			// fallback when the volume refuses to report one.
			FSType:     volumeFilesystem(rootPtr),
			SizeBytes:  total,
			UsedBytes:  total - totalFree,
			AvailBytes: totalFree,
		})
	}

	sort.Slice(drives, func(i, j int) bool { return drives[i].Device < drives[j].Device })
	return drives
}

func volumeFilesystem(root *uint16) string {
	fsName := make([]uint16, 256)
	err := windows.GetVolumeInformation(root, nil, 0, nil, nil, nil, &fsName[0], uint32(len(fsName)))
	if err != nil {
		return "ntfs"
	}
	name := strings.TrimSpace(windows.UTF16ToString(fsName))
	if name == "" {
		return "ntfs"
	}
	return strings.ToLower(name)
}

// splitNullSeparated turns the NUL-separated, double-NUL-terminated string list
// Win32 likes to return into a Go slice.
func splitNullSeparated(buffer []uint16) []string {
	values := []string{}
	start := 0
	for index := 0; index < len(buffer); index++ {
		if buffer[index] != 0 {
			continue
		}
		if index > start {
			values = append(values, windows.UTF16ToString(buffer[start:index]))
		}
		start = index + 1
	}
	return values
}

// IPAddresses returns the host's routable unicast addresses, sorted and
// de-duplicated.
//
// Loopback, link-local and tentative/deprecated addresses are filtered out: the
// dashboard uses this list to tell an operator how to reach the machine, and
// none of those get you there. This mirrors the filter the Python agent applied
// through Get-NetIPAddress.
func IPAddresses() []string {
	const workBufferSize = 15000
	size := uint32(workBufferSize)
	var addresses []byte

	// The documented pattern: grow the buffer until the call stops complaining.
	for attempt := 0; attempt < 4; attempt++ {
		addresses = make([]byte, size)
		err := windows.GetAdaptersAddresses(
			windows.AF_UNSPEC,
			windows.GAA_FLAG_SKIP_ANYCAST|windows.GAA_FLAG_SKIP_MULTICAST|windows.GAA_FLAG_SKIP_DNS_SERVER,
			0,
			(*windows.IpAdapterAddresses)(unsafe.Pointer(&addresses[0])),
			&size,
		)
		if err == nil {
			break
		}
		if err != windows.ERROR_BUFFER_OVERFLOW {
			return []string{}
		}
		if attempt == 3 {
			return []string{}
		}
	}

	seen := map[string]bool{}
	result := []string{}
	for adapter := (*windows.IpAdapterAddresses)(unsafe.Pointer(&addresses[0])); adapter != nil; adapter = adapter.Next {
		if adapter.OperStatus != windows.IfOperStatusUp {
			continue
		}
		for unicast := adapter.FirstUnicastAddress; unicast != nil; unicast = unicast.Next {
			ip := unicast.Address.IP()
			if ip == nil {
				continue
			}
			text := ip.String()
			if text == "" || seen[text] {
				continue
			}
			if strings.HasPrefix(text, "127.") || text == "::1" || strings.HasPrefix(strings.ToLower(text), "fe80") {
				continue
			}
			seen[text] = true
			result = append(result, text)
		}
	}

	sort.Strings(result)
	return result
}
