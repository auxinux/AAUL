// Package packages implements the remote package management commands on top of
// winget.
//
// SECURITY MODEL (defence in depth — the dashboard validates too, but the agent
// NEVER trusts the dashboard blindly), carried over unchanged from the Python
// agent (agent/app/lib/packages.py):
//
//   - commands are executed ONLY through fixed argument lists, never a shell
//     string, so a package name can never be interpreted as syntax;
//   - names are validated against a strict allowlist charset;
//   - a hardcoded blacklist blocks boot/system-critical packages;
//   - installs are by Id from the configured winget sources only — no URLs,
//     no local installer paths.
package packages

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"aaul-agent/internal/logs"
)

// Manager is the value reported to the dashboard in every payload. It matches
// detect_package_manager() on Windows.
const Manager = "windows"

// Strict package-name charset. Must start alphanumeric, then a small safe set.
// winget Ids ("Mozilla.Firefox", "7zip.7zip", "Microsoft.VisualStudioCode") all
// satisfy it; MSI ARP entries such as "{90160000-...}" do not, and are refused
// on purpose.
var packageNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+@-]{0,100}$`)

// Search queries may contain spaces but no control or shell characters.
var searchQueryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,100}$`)

// Boot/system critical packages that must never be installed or removed here.
// The list is shared with the Python agent so the policy cannot drift between
// the two implementations, even though most entries describe Linux packages
// that no winget source can serve.
var blacklistPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^grub`), regexp.MustCompile(`grub2`), regexp.MustCompile(`grub-`),
	regexp.MustCompile(`^linux-image`), regexp.MustCompile(`^linux-headers`), regexp.MustCompile(`^linux-firmware`),
	regexp.MustCompile(`^kernel`), regexp.MustCompile(`-kernel`), regexp.MustCompile(`^linux$`), regexp.MustCompile(`^linux-lts`),
	regexp.MustCompile(`^systemd$`), regexp.MustCompile(`^systemd-`), regexp.MustCompile(`^init$`), regexp.MustCompile(`^sysvinit`), regexp.MustCompile(`^upstart$`),
	regexp.MustCompile(`^libc6$`), regexp.MustCompile(`^glibc`), regexp.MustCompile(`^libc-bin$`), regexp.MustCompile(`^musl$`),
	regexp.MustCompile(`^dpkg$`), regexp.MustCompile(`^apt$`), regexp.MustCompile(`^apt-get$`), regexp.MustCompile(`^rpm$`), regexp.MustCompile(`^dnf$`), regexp.MustCompile(`^yum$`),
	regexp.MustCompile(`^pacman$`), regexp.MustCompile(`^zypper$`), regexp.MustCompile(`^portage$`),
	regexp.MustCompile(`^bash$`), regexp.MustCompile(`^dash$`), regexp.MustCompile(`^coreutils$`), regexp.MustCompile(`^util-linux$`),
	regexp.MustCompile(`^shim`), regexp.MustCompile(`^efibootmgr$`), regexp.MustCompile(`^os-prober$`),
	regexp.MustCompile(`^mkinitcpio$`), regexp.MustCompile(`^dracut$`), regexp.MustCompile(`^initramfs-tools`),
	regexp.MustCompile(`^syslinux`), regexp.MustCompile(`^refind`), regexp.MustCompile(`^bootctl$`), regexp.MustCompile(`^sudo$`),
}

// IsBlacklisted reports whether a package is boot/system-critical.
func IsBlacklisted(name string) bool {
	lowered := strings.ToLower(strings.TrimSpace(name))
	for _, pattern := range blacklistPatterns {
		if pattern.MatchString(lowered) {
			return true
		}
	}
	return false
}

// Error is a user-facing package-management failure. The messages are in French
// to match the strings the dashboard already displays for Linux agents.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

func validateName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !packageNamePattern.MatchString(name) {
		return "", &Error{"Nom de paquet invalide"}
	}
	if IsBlacklisted(name) {
		return "", &Error{"Paquet protégé (critique pour le système) — opération refusée"}
	}
	return name, nil
}

func validateQuery(query string) (string, error) {
	query = strings.TrimSpace(query)
	if !searchQueryPattern.MatchString(query) {
		return "", &Error{"Requête de recherche invalide"}
	}
	return query, nil
}

// Package is one installed package.
type Package struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// ListResult is the PACKAGES_LIST payload.
type ListResult struct {
	Manager  string    `json:"manager"`
	Packages []Package `json:"packages"`
	Count    int       `json:"count"`
}

// unparsedOutput turns output we could not read into an error the operator can
// act on.
//
// Reporting an empty list instead would be worse than useless: the dashboard
// renders "no packages" exactly like "you have not run this yet", so a machine
// whose winget answers something unexpected looks like a button that does
// nothing. The raw output is the only thing that says why.
func unparsedOutput(command, output string) error {
	binary, _ := Locate()
	trimmed := strings.TrimSpace(output)
	if trimmed == "" {
		return &Error{fmt.Sprintf("winget %s n'a produit aucune sortie (%s)", command, binary)}
	}
	// The head, not the tail: a parse failure is about the header and the rule
	// under it, which are the first two lines. Showing the tail cut the answer
	// off mid-word the first time this fired.
	return &Error{fmt.Sprintf(
		"sortie de winget %s illisible (aucun tableau trouve).\nBinaire : %s\nDebut de la sortie brute :\n%s",
		command, binary, headOutput(trimmed))}
}

// ListInstalled returns every package winget knows about on this machine.
func ListInstalled() (*ListResult, error) {
	output, err := run(queryTimeout, "list")
	if err != nil {
		return nil, err
	}

	rows, sawTable := ParseTableResult(output)
	// A machine always has installed packages, so a missing table here is a
	// failure to read the output, not an empty result.
	if !sawTable {
		return nil, unparsedOutput("list", output)
	}

	items := []Package{}
	for _, row := range rows {
		items = append(items, Package{Name: row.Get(1), Version: row.Get(2)})
	}
	sort.Slice(items, func(i, j int) bool {
		return strings.ToLower(items[i].Name) < strings.ToLower(items[j].Name)
	})
	return &ListResult{Manager: Manager, Packages: items, Count: len(items)}, nil
}

// SearchHit is one search result.
type SearchHit struct {
	Name    string `json:"name"`
	Summary string `json:"summary"`
}

// SearchResult is the PACKAGE_SEARCH payload.
type SearchResult struct {
	Manager string      `json:"manager"`
	Query   string      `json:"query"`
	Results []SearchHit `json:"results"`
}

// maxSearchResults caps the payload so a broad query cannot produce a huge
// command result.
const maxSearchResults = 200

// Search looks for installable packages.
//
// `name` is the winget Id rather than the display name, because that Id is what
// Install expects — the dashboard offers search results as install targets.
func Search(query string) (*SearchResult, error) {
	query, err := validateQuery(query)
	if err != nil {
		return nil, err
	}
	output, err := run(queryTimeout, "search", query)
	if err != nil {
		return nil, err
	}

	rows, sawTable := ParseTableResult(output)
	// Unlike `list`, a search legitimately returns nothing when no package
	// matches -- but winget still prints "No package found matching..." rather
	// than a table, so only a non-empty unparsed output is suspicious.
	if !sawTable && !mentionsNoResult(output) {
		return nil, unparsedOutput("search", output)
	}

	hits := []SearchHit{}
	for _, row := range rows {
		id := row.Get(1)
		if id == "" {
			continue
		}
		hits = append(hits, SearchHit{Name: id, Summary: row.Get(0)})
		if len(hits) >= maxSearchResults {
			break
		}
	}
	return &SearchResult{Manager: Manager, Query: query, Results: hits}, nil
}

// ActionResult is the payload of an install, remove or update command.
type ActionResult struct {
	Action  string   `json:"action"`
	Name    string   `json:"name,omitempty"`
	Names   []string `json:"names,omitempty"`
	Manager string   `json:"manager"`
	Success bool     `json:"success"`
	Output  string   `json:"output"`
}

// maxOutputBytes caps the transcript returned to the dashboard, matching the
// Python agent's [-4000:] slice.
const maxOutputBytes = 4000

// headOutput keeps the beginning of a transcript, for diagnosing how output
// starts rather than how it ended.
func headOutput(text string) string {
	runes := []rune(text)
	if len(runes) <= maxOutputBytes {
		return text
	}
	return string(runes[:maxOutputBytes])
}

func tailOutput(text string) string {
	runes := []rune(text)
	if len(runes) <= maxOutputBytes {
		return text
	}
	return string(runes[len(runes)-maxOutputBytes:])
}

// Install installs a package by winget Id.
func Install(name string) (*ActionResult, error) {
	name, err := validateName(name)
	if err != nil {
		return nil, err
	}
	logs.Append("[packages] install %s via %s", name, Manager)
	output, runErr := run(actionTimeout,
		"install", "--silent", "--accept-package-agreements",
		"--accept-source-agreements", "--exact", "--id", name)
	return &ActionResult{
		Action:  "install",
		Name:    name,
		Manager: Manager,
		Success: runErr == nil,
		Output:  tailOutput(output),
	}, nil
}

// Remove uninstalls a package by winget Id.
func Remove(name string) (*ActionResult, error) {
	name, err := validateName(name)
	if err != nil {
		return nil, err
	}
	logs.Append("[packages] remove %s via %s", name, Manager)
	output, runErr := run(actionTimeout, "uninstall", "--silent", "--exact", "--id", name)
	return &ActionResult{
		Action:  "remove",
		Name:    name,
		Manager: Manager,
		Success: runErr == nil,
		Output:  tailOutput(output),
	}, nil
}

// Update is one available upgrade.
type Update struct {
	Name       string `json:"name"`
	Detail     string `json:"detail"`
	Version    string `json:"version"`
	NewVersion string `json:"newVersion"`
	Source     string `json:"source"`
	// Security is always false here: winget publishes no per-package security
	// metadata, and the dashboard prefers an honest false to a fabricated guess.
	Security bool `json:"security"`
}

// UpdatesResult is the CHECK_UPDATES payload.
type UpdatesResult struct {
	Manager       string   `json:"manager"`
	Updates       []Update `json:"updates"`
	Count         int      `json:"count"`
	SecurityCount int      `json:"securityCount"`
}

// CheckUpdates lists available upgrades without installing anything.
func CheckUpdates() (*UpdatesResult, error) {
	output, err := run(queryTimeout, "upgrade")
	if err != nil {
		return nil, err
	}

	rows, _ := ParseTableResult(output)
	// `upgrade` prints no table when everything is up to date, which is the
	// common case and a perfectly good answer.
	updates := []Update{}
	for _, row := range rows {
		id := row.Get(1)
		if id == "" {
			continue
		}
		current, available := row.Get(2), row.Get(3)
		updates = append(updates, Update{
			Name:       id,
			Detail:     strings.TrimSpace(fmt.Sprintf("%s: %s -> %s", row.Get(0), current, available)),
			Version:    current,
			NewVersion: available,
			Source:     "winget",
		})
	}
	return &UpdatesResult{
		Manager: Manager,
		Updates: updates,
		Count:   len(updates),
	}, nil
}

// UpdatePackages upgrades only the named packages.
//
// winget upgrades one package per invocation, so failures are reported as a
// whole: success means every package upgraded.
func UpdatePackages(names []string) (*ActionResult, error) {
	if len(names) == 0 {
		return nil, &Error{"Aucun paquet spécifié"}
	}
	clean := make([]string, 0, len(names))
	for _, name := range names {
		validated, err := validateName(name)
		if err != nil {
			return nil, err
		}
		clean = append(clean, validated)
	}
	logs.Append("[packages] update %d package(s) via %s", len(clean), Manager)

	var transcript strings.Builder
	success := true
	for _, name := range clean {
		output, err := run(actionTimeout,
			"upgrade", "--silent", "--accept-package-agreements",
			"--accept-source-agreements", "--exact", "--id", name)
		fmt.Fprintf(&transcript, "$ winget upgrade --id %s\n%s\n", name, output)
		if err != nil {
			success = false
		}
	}

	return &ActionResult{
		Action:  "update",
		Names:   clean,
		Manager: Manager,
		Success: success,
		Output:  tailOutput(transcript.String()),
	}, nil
}

// mentionsNoResult recognises winget's "nothing matched" wording without
// depending on the UI language: every locale prints the criteria phrase with
// the same shape, so the check stays on the structure -- a short output with no
// table and no error markers.
func mentionsNoResult(output string) bool {
	return len(strings.TrimSpace(output)) < 200
}

// Sources lists the configured winget sources, one entry per line, in the shape
// the dashboard shows under "repositories".
func Sources() ([]string, error) {
	output, err := run(queryTimeout, "source", "list")
	if err != nil {
		return nil, err
	}
	entries := []string{}
	for _, row := range ParseTable(output) {
		name, argument := row.Get(0), row.Get(1)
		entries = append(entries, strings.TrimSpace(name+" "+argument))
	}
	return entries, nil
}
