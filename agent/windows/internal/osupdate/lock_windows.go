//go:build windows

package osupdate

import (
	"golang.org/x/sys/windows"
)

// mutexName is machine-wide. The Global namespace matters: the service runs as
// LocalSystem in session 0 while a scheduled task or an operator's `aaul-agent
// update` runs elsewhere, and a session-local mutex would not be seen across
// that boundary.
const mutexName = `Global\AgentAutoUpdate.Update`

// updateLock is a cross-process mutual exclusion on the update run. Two
// concurrent winget or Windows Update sessions on one machine fight over the
// same installer locks and produce failures that look like update errors.
type updateLock struct {
	handle windows.Handle
}

// acquireLock takes the machine-wide update lock, returning nil when another
// process already holds it.
func acquireLock() *updateLock {
	name, err := windows.UTF16PtrFromString(mutexName)
	if err != nil {
		return nil
	}
	handle, err := windows.CreateMutex(nil, false, name)
	// ERROR_ALREADY_EXISTS still returns a usable handle: the mutex exists but
	// may well be unowned, so the wait below is what actually decides.
	if handle == 0 {
		return nil
	}
	if err != nil && err != windows.ERROR_ALREADY_EXISTS {
		windows.CloseHandle(handle)
		return nil
	}

	event, waitErr := windows.WaitForSingleObject(handle, 0)
	switch {
	case event == windows.WAIT_OBJECT_0:
		return &updateLock{handle: handle}
	case event == uint32(windows.WAIT_ABANDONED):
		// The previous holder died without releasing. Ownership transfers to
		// us, which is exactly what should happen after a crashed update.
		return &updateLock{handle: handle}
	default:
		_ = waitErr
		windows.CloseHandle(handle)
		return nil
	}
}

func (l *updateLock) release() {
	if l == nil || l.handle == 0 {
		return
	}
	windows.ReleaseMutex(l.handle)
	windows.CloseHandle(l.handle)
	l.handle = 0
}
