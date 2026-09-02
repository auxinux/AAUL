// Package version holds the agent version.
//
// The value is stamped at build time by release.sh with
//
//	-ldflags "-X aaul-agent/internal/version.Version=$AGENT_VER"
//
// from agent/app/VERSION, the same file the Python agent bundle uses. The two
// agents share one version number so the dashboard keeps a single readVersion()
// and its "update available" comparison (dashboard/server/utils/monitor.js:109)
// stays correct for every platform.
package version

// Version is the running agent version. The placeholder only survives in a
// developer build made without ldflags.
var Version = "0.0.0-dev"
