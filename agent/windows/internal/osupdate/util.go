package osupdate

import (
	"errors"
	"os/exec"
	"strings"
)

// asExitError distinguishes "the command ran and failed" from "the command
// could not be started at all". Only the former carries a meaningful exit code.
func asExitError(err error, target **exec.ExitError) bool {
	return errors.As(err, target)
}

// shellJoin renders a command for the log transcript. It is display-only —
// commands are always executed as fixed argument lists, never through a shell.
func shellJoin(command []string) string {
	parts := make([]string, 0, len(command))
	for _, argument := range command {
		if strings.ContainsAny(argument, " \t\"") {
			parts = append(parts, `"`+strings.ReplaceAll(argument, `"`, `\"`)+`"`)
			continue
		}
		parts = append(parts, argument)
	}
	return strings.Join(parts, " ")
}
