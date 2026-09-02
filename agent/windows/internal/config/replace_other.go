//go:build !windows

package config

import "os"

// replaceFile is only exercised by the unit tests, which run on the build host.
func replaceFile(src, dst string) error {
	return os.Rename(src, dst)
}
