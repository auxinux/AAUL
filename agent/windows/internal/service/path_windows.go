//go:build windows

package service

import (
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func equalPath(left, right string) bool {
	return strings.EqualFold(strings.TrimRight(left, `\`), strings.TrimRight(right, `\`))
}

// updateSystemPath rewrites the machine PATH through the transform.
//
// The value is written back as REG_EXPAND_SZ, the type Windows uses there:
// rewriting it as a plain string would flatten entries like %SystemRoot% for
// every process started afterwards.
func updateSystemPath(transform func([]string) []string) error {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, environmentKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()

	current, valueType, err := key.GetStringValue("Path")
	if err != nil {
		return err
	}

	entries := []string{}
	for _, entry := range strings.Split(current, ";") {
		if strings.TrimSpace(entry) != "" {
			entries = append(entries, entry)
		}
	}

	updated := transform(entries)
	next := strings.Join(updated, ";")
	if next == current {
		return nil
	}

	if valueType == registry.EXPAND_SZ {
		if err := key.SetExpandStringValue("Path", next); err != nil {
			return err
		}
	} else if err := key.SetStringValue("Path", next); err != nil {
		return err
	}

	broadcastEnvironmentChange()
	return nil
}

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procSendMessageTimeoutW = user32.NewProc("SendMessageTimeoutW")
)

// broadcastEnvironmentChange tells already-running shells to re-read the
// environment. Without it, PATH only takes effect after a reboot.
func broadcastEnvironmentChange() {
	const (
		hwndBroadcast   = 0xFFFF
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
	)
	environment, err := windows.UTF16PtrFromString("Environment")
	if err != nil {
		return
	}
	var result uintptr
	procSendMessageTimeoutW.Call(
		uintptr(hwndBroadcast),
		uintptr(wmSettingChange),
		0,
		uintptr(unsafePointer(environment)),
		uintptr(smtoAbortIfHung),
		uintptr(5000),
		uintptr(unsafePointer(&result)),
	)
}
