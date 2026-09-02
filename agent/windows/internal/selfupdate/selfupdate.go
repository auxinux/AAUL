// Package selfupdate replaces the running agent binary with the one published
// by the dashboard.
//
// The Python agent downloaded a tarball and swapped a directory. A single
// executable is simpler but has one Windows-specific constraint: a running .exe
// cannot be deleted or overwritten — yet it *can* be renamed. The swap is built
// on that: move the old binary aside, move the new one into place, restart, and
// delete the leftover on the next start. No helper process, no scheduled task,
// nothing to clean up if the machine loses power mid-update.
package selfupdate

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"aaul-agent/internal/api"
	"aaul-agent/internal/logs"
)

// DownloadPath is the dashboard route serving the Windows agent binary.
const DownloadPath = "/agent/windows/latest.exe"

// downloadTimeout is generous: the binary is a few megabytes but the link to a
// remote site may not be.
const downloadTimeout = 5 * time.Minute

// Error is a self-update failure. It is reported to the dashboard as the
// command's error message.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

func newError(format string, args ...any) *Error {
	return &Error{Message: fmt.Sprintf(format, args...)}
}

// suffixes for the two transient files that live next to the binary.
const (
	pendingSuffix  = ".new"
	previousSuffix = ".old"
)

// Run downloads, verifies and installs the published agent binary, returning
// the new version. The caller is responsible for restarting the service.
func Run(client *api.Client, currentVersion string) (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", newError("chemin de l'exécutable introuvable: %v", err)
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return "", newError("chemin de l'exécutable introuvable: %v", err)
	}

	response, err := client.Get(DownloadPath, downloadTimeout)
	if err != nil {
		return "", newError("téléchargement impossible: %v", err)
	}
	defer response.Body.Close()

	expectedSha := strings.ToLower(strings.TrimSpace(response.Header.Get("X-Bundle-Sha256")))
	expectedSignature := strings.ToLower(strings.TrimSpace(response.Header.Get("X-Bundle-Signature")))
	newVersion := strings.TrimSpace(response.Header.Get("X-Bundle-Version"))
	if expectedSha == "" || expectedSignature == "" {
		return "", newError("métadonnées d'intégrité absentes de la réponse")
	}

	pendingPath := executable + pendingSuffix
	// A previous attempt may have died between download and swap.
	os.Remove(pendingPath)

	actualSha, err := downloadTo(pendingPath, response.Body)
	if err != nil {
		os.Remove(pendingPath)
		return "", newError("écriture du binaire échouée: %v", err)
	}

	if !hmac.Equal([]byte(actualSha), []byte(expectedSha)) {
		os.Remove(pendingPath)
		return "", newError("empreinte du binaire invalide")
	}
	// The dashboard signs the hash with this agent's own API token, so a proxy
	// that can serve bytes still cannot serve a binary this agent will run.
	signature := api.ComputeHMAC(expectedSha, client.Token())
	if !hmac.Equal([]byte(signature), []byte(expectedSignature)) {
		os.Remove(pendingPath)
		return "", newError("signature du binaire invalide")
	}

	if newVersion == "" {
		newVersion = currentVersion
	}

	previousPath := executable + previousSuffix
	os.Remove(previousPath)

	// Renaming the running executable is legal on Windows; deleting it is not.
	if err := os.Rename(executable, previousPath); err != nil {
		os.Remove(pendingPath)
		return "", newError("mise de côté de l'ancien binaire impossible: %v", err)
	}
	if err := os.Rename(pendingPath, executable); err != nil {
		// Put the working binary back so the service can still start.
		if restoreErr := os.Rename(previousPath, executable); restoreErr != nil {
			logs.Append("[update] CRITICAL: could not restore %s: %v", executable, restoreErr)
		}
		os.Remove(pendingPath)
		return "", newError("installation du nouveau binaire impossible: %v", err)
	}

	logs.Append("[update] agent updated to %s (previous binary kept at %s)", newVersion, previousPath)
	return newVersion, nil
}

// downloadTo streams the body to disk while hashing it, so the file is never
// read twice and never held in memory.
func downloadTo(path string, body io.Reader) (string, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	handle, err := os.OpenFile(path, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", err
	}
	defer handle.Close()

	digest := sha256.New()
	if _, err := io.Copy(io.MultiWriter(handle, digest), body); err != nil {
		return "", err
	}
	if err := handle.Sync(); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// CleanupPrevious removes the binary left behind by the last successful update.
// Called at startup, once the new binary is demonstrably able to run.
func CleanupPrevious() {
	executable, err := os.Executable()
	if err != nil {
		return
	}
	for _, suffix := range []string{previousSuffix, pendingSuffix} {
		path := executable + suffix
		if _, err := os.Stat(path); err != nil {
			continue
		}
		if err := os.Remove(path); err != nil {
			// Not fatal: it will be retried at the next start.
			logs.Append("[update] could not remove %s: %v", path, err)
			continue
		}
		logs.Append("[update] removed leftover %s", filepath.Base(path))
	}
}
