//go:build windows

package service

import "unsafe"

// unsafePointer keeps the unsafe import confined to a single file, so the rest
// of the package reads as ordinary Go.
func unsafePointer[T any](value *T) unsafe.Pointer {
	return unsafe.Pointer(value)
}
