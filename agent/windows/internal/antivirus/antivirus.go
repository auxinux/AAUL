// Package antivirus reports antivirus health and runs on-demand scans.
//
// The JSON this produces is the same contract the Python agent returns from
// lib/antivirus.py: the dashboard renders both without knowing which agent
// answered, so field names and semantics are not ours to change.
//
// The readings themselves come from Windows Defender (antivirus_windows.go).
// Everything in this file is pure mapping and verdict logic, kept free of the
// windows build tag so it can be tested on any host.
package antivirus

import (
	"fmt"
	"strings"
	"time"
)

// StaleSignatureDays is what "out of date" means for the health roll-up,
// matching STALE_SIGNATURE_DAYS in the Python agent.
const StaleSignatureDays = 7

// rawStatus is what the PowerShell probe emits. Every field is optional: a
// machine with Defender turned off by a third-party suite still answers, just
// with less in it.
type rawStatus struct {
	DefenderPresent           bool         `json:"defenderPresent"`
	AMProductVersion          string       `json:"amProductVersion"`
	AMServiceEnabled          bool         `json:"amServiceEnabled"`
	AntivirusEnabled          bool         `json:"antivirusEnabled"`
	RealTimeProtectionEnabled bool         `json:"realTimeProtectionEnabled"`
	SignatureVersion          string       `json:"signatureVersion"`
	SignatureLastUpdated      string       `json:"signatureLastUpdated"`
	SignatureAge              *int         `json:"signatureAge"`
	QuickScanEndTime          string       `json:"quickScanEndTime"`
	FullScanEndTime           string       `json:"fullScanEndTime"`
	Threats                   []rawThreat  `json:"threats"`
	Products                  []rawProduct `json:"products"`
}

type rawThreat struct {
	Name        string `json:"name"`
	SeverityID  int    `json:"severityId"`
	StatusID    int    `json:"statusId"`
	DetectedAt  string `json:"detectedAt"`
	ProcessName string `json:"processName"`
}

// rawProduct is a Security Center registration — how Windows itself knows an
// antivirus is installed, including third-party suites that switch Defender off.
type rawProduct struct {
	Name         string `json:"name"`
	ProductState int    `json:"productState"`
}

var severityNames = map[int]string{
	1: "low",
	2: "moderate",
	3: "high",
	4: "severe",
}

var statusNames = map[int]string{
	1: "detected",
	2: "cleaned",
	3: "quarantined",
	4: "removed",
	5: "allowed",
	6: "blocked",
}

func severityName(id int) string {
	if name, ok := severityNames[id]; ok {
		return name
	}
	return "unknown"
}

func statusName(id int) string {
	if name, ok := statusNames[id]; ok {
		return name
	}
	return "unknown"
}

// decodeProductState reads the Security Center bitmask.
//
// The value is three meaningful bytes: the middle one says whether the scanner
// is on (0x10 / 0x11), the low one whether the signatures are current (0x00).
// It is the only way to learn anything about a third-party antivirus, which
// does not expose the Defender cmdlets.
func decodeProductState(state int) (enabled bool, upToDate bool) {
	scanner := (state >> 8) & 0xFF
	signatures := state & 0xFF
	return scanner == 0x10 || scanner == 0x11, signatures == 0x00
}

// isDefender reports whether a Security Center registration is Defender itself,
// so the same product is not counted twice.
func isDefender(name string) bool {
	lowered := strings.ToLower(name)
	return strings.Contains(lowered, "windows defender") ||
		strings.Contains(lowered, "microsoft defender")
}

// latestScan picks the most recent of the quick and full scan timestamps, and
// says which one it was — the dashboard shows a single "last scan" line.
func latestScan(quick, full string) (at string, kind string) {
	quickTime, quickOK := parseTime(quick)
	fullTime, fullOK := parseTime(full)
	switch {
	case quickOK && fullOK:
		if fullTime.After(quickTime) {
			return full, "full"
		}
		return quick, "quick"
	case quickOK:
		return quick, "quick"
	case fullOK:
		return full, "full"
	}
	return "", ""
}

func parseTime(value string) (time.Time, bool) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, false
	}
	return parsed, true
}

// buildStatus turns the probe output into the dashboard contract.
func buildStatus(raw rawStatus, now time.Time) map[string]any {
	status := emptyStatus(now)

	// A third-party suite that registered with Security Center is the product
	// actually protecting this machine, even when Defender still answers.
	var thirdParty *rawProduct
	others := []map[string]any{}
	for i := range raw.Products {
		product := raw.Products[i]
		if isDefender(product.Name) {
			continue
		}
		enabled, upToDate := decodeProductState(product.ProductState)
		others = append(others, map[string]any{
			"name":     product.Name,
			"enabled":  enabled,
			"upToDate": upToDate,
		})
		if thirdParty == nil || enabled {
			copied := product
			thirdParty = &copied
		}
	}

	defenderActive := raw.DefenderPresent && raw.AntivirusEnabled && raw.AMServiceEnabled

	switch {
	case defenderActive:
		applyDefender(status, raw)
	case thirdParty != nil:
		enabled, upToDate := decodeProductState(thirdParty.ProductState)
		status["installed"] = true
		status["product"] = thirdParty.Name
		status["enabled"] = enabled
		// Security Center exposes no real-time flag of its own: an enabled
		// scanner is the closest honest answer, and claiming more would make
		// the health verdict a guess.
		status["realtimeEnabled"] = enabled
		status["daemonRunning"] = enabled
		status["upToDate"] = upToDate
		// Only the product's own console can start a scan for it.
		status["scanSupported"] = false
	case raw.DefenderPresent:
		// Defender is installed but switched off, and nothing replaced it.
		applyDefender(status, raw)
		status["installed"] = true
	}

	status["otherProducts"] = others
	return rollUp(status)
}

func applyDefender(status map[string]any, raw rawStatus) {
	status["installed"] = true
	status["product"] = "Microsoft Defender"
	status["version"] = nullable(raw.AMProductVersion)
	status["enabled"] = raw.AntivirusEnabled && raw.AMServiceEnabled
	status["realtimeEnabled"] = raw.RealTimeProtectionEnabled
	status["daemonRunning"] = raw.AMServiceEnabled
	// Defender updates signatures through Windows Update, which the agent
	// already reports on separately.
	status["autoUpdateEnabled"] = true
	status["signatureVersion"] = nullable(raw.SignatureVersion)
	status["signatureUpdatedAt"] = nullable(raw.SignatureLastUpdated)
	status["scanSupported"] = true

	if raw.SignatureAge != nil {
		status["signatureAgeDays"] = *raw.SignatureAge
		status["upToDate"] = *raw.SignatureAge <= StaleSignatureDays
	}

	scanAt, scanKind := latestScan(raw.QuickScanEndTime, raw.FullScanEndTime)
	status["lastScanAt"] = nullable(scanAt)
	status["lastScanType"] = nullable(scanKind)

	threats := make([]map[string]any, 0, len(raw.Threats))
	for _, threat := range raw.Threats {
		threats = append(threats, map[string]any{
			"name":       threat.Name,
			"path":       threat.ProcessName,
			"severity":   severityName(threat.SeverityID),
			"detectedAt": threat.DetectedAt,
			"action":     statusName(threat.StatusID),
		})
	}
	status["threats"] = threats
	status["threatsFound"] = len(threats)
}

func emptyStatus(now time.Time) map[string]any {
	return map[string]any{
		"supported":          true,
		"installed":          false,
		"product":            nil,
		"version":            nil,
		"enabled":            false,
		"realtimeEnabled":    false,
		"daemonRunning":      false,
		"autoUpdateEnabled":  false,
		"signatureVersion":   nil,
		"signatureUpdatedAt": nil,
		"signatureAgeDays":   nil,
		"upToDate":           false,
		"scanSupported":      false,
		"lastScanAt":         nil,
		"lastScanType":       nil,
		"threatsFound":       0,
		"threats":            []map[string]any{},
		"otherProducts":      []map[string]any{},
		"healthy":            false,
		"issues":             []string{},
		"checkedAt":          now.UTC().Format(time.RFC3339),
	}
}

// rollUp turns the raw readings into the verdict the dashboard displays. The
// wording matches the Python agent so a mixed fleet reads consistently.
func rollUp(status map[string]any) map[string]any {
	issues := []string{}

	if installed, _ := status["installed"].(bool); !installed {
		issues = append(issues, "Aucun antivirus détecté")
	} else {
		if enabled, _ := status["enabled"].(bool); !enabled {
			issues = append(issues, "Antivirus désactivé")
		}
		if realtime, _ := status["realtimeEnabled"].(bool); !realtime {
			issues = append(issues, "Protection en temps réel inactive")
		}
		if upToDate, _ := status["upToDate"].(bool); !upToDate {
			if age, ok := status["signatureAgeDays"].(int); ok {
				issues = append(issues, fmt.Sprintf("Signatures obsolètes (%d jours)", age))
			} else {
				issues = append(issues, "Âge des signatures inconnu")
			}
		}
		if found, _ := status["threatsFound"].(int); found > 0 {
			issues = append(issues, fmt.Sprintf("%d menace(s) détectée(s)", found))
		}
	}

	status["issues"] = issues
	status["healthy"] = len(issues) == 0
	return status
}

func nullable(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

// normalizeScanType keeps the agent from trusting the dashboard blindly, the
// same way the package commands validate their own inputs.
func normalizeScanType(scanType string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(scanType)) {
	case "", "quick":
		return "quick", nil
	case "full":
		return "full", nil
	}
	return "", fmt.Errorf("Type de scan invalide (quick ou full)")
}

// buildScanResult renders a finished scan in the same shape the Python agent
// returns, so the dashboard has one result format to display.
//
// Defender reports neither a file count nor a transcript — it decides its own
// targets and keeps the detail in its own history — so those fields stay empty
// rather than being filled with a number that would only look authoritative.
func buildScanResult(scanType, engine string, started, finished time.Time, found []rawThreat) map[string]any {
	threats := make([]map[string]any, 0, len(found))
	for _, threat := range found {
		threats = append(threats, map[string]any{
			"name":       threat.Name,
			"path":       threat.ProcessName,
			"severity":   severityName(threat.SeverityID),
			"detectedAt": threat.DetectedAt,
			"action":     statusName(threat.StatusID),
		})
	}

	scanStatus := "clean"
	if len(threats) > 0 {
		scanStatus = "infected"
	}

	return map[string]any{
		"scanType":        scanType,
		"engine":          engine,
		"targets":         []string{},
		"startedAt":       started.UTC().Format(time.RFC3339),
		"finishedAt":      finished.UTC().Format(time.RFC3339),
		"durationSeconds": int(finished.Sub(started).Seconds()),
		"filesScanned":    nil,
		"threatsFound":    len(threats),
		"threats":         threats,
		"status":          scanStatus,
		"output":          "",
	}
}
