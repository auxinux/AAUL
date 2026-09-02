//go:build windows

package config

import "golang.org/x/sys/windows"

// replaceFile overwrites dst with src. os.Rename maps to MoveFileEx without
// MOVEFILE_REPLACE_EXISTING on Windows and fails when dst already exists, so
// the flag is passed explicitly. MOVEFILE_WRITE_THROUGH makes the swap durable.
func replaceFile(src, dst string) error {
	from, err := windows.UTF16PtrFromString(src)
	if err != nil {
		return err
	}
	to, err := windows.UTF16PtrFromString(dst)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(from, to, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
