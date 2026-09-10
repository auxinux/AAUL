//go:build windows

package antivirus

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"aaul-agent/internal/logs"
)

// Defender is driven through its PowerShell module rather than WMI: the
// MSFT_MpComputerStatus namespace is not stable across Windows editions,
// while Get-MpComputerStatus / Start-MpScan are the documented interface and
// ship with every install. This is on-demand only — nothing here runs on the
// poll path, unlike metrics, which deliberately avoids spawning anything.
const (
	statusTimeout    = 2 * time.Minute
	quickScanTimeout = time.Hour
	fullScanTimeout  = 6 * time.Hour
)

// statusScript collects everything the contract needs in a single launch:
// Defender's own state, its threat history, and the Security Center registry
// that also lists third-party antivirus products.
const statusScript = `
$ErrorActionPreference = 'SilentlyContinue'
$out = [ordered]@{ defenderPresent = $false }
$status = Get-MpComputerStatus
if ($status) {
  $out.defenderPresent = $true
  $out.amProductVersion = [string]$status.AMProductVersion
  $out.amServiceEnabled = [bool]$status.AMServiceEnabled
  $out.antivirusEnabled = [bool]$status.AntivirusEnabled
  $out.realTimeProtectionEnabled = [bool]$status.RealTimeProtectionEnabled
  $out.signatureVersion = [string]$status.AntivirusSignatureVersion
  $out.signatureAge = [int]$status.AntivirusSignatureAge
  if ($status.AntivirusSignatureLastUpdated) {
    $out.signatureLastUpdated = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  if ($status.QuickScanEndTime) {
    $out.quickScanEndTime = $status.QuickScanEndTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
  if ($status.FullScanEndTime) {
    $out.fullScanEndTime = $status.FullScanEndTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  }
}
$names = @{}
foreach ($threat in @(Get-MpThreat)) { $names[[string]$threat.ThreatID] = $threat }
$threats = @()
foreach ($detection in @(Get-MpThreatDetection)) {
  $known = $names[[string]$detection.ThreatID]
  $threats += [ordered]@{
    name        = if ($known) { [string]$known.ThreatName } else { "ThreatID $($detection.ThreatID)" }
    severityId  = if ($known) { [int]$known.SeverityID } else { 0 }
    statusId    = [int]$detection.ThreatStatusID
    detectedAt  = if ($detection.InitialDetectionTime) { $detection.InitialDetectionTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { $null }
    processName = [string]$detection.ProcessName
  }
}
$out.threats = @($threats)
$products = @()
foreach ($product in @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct)) {
  $products += [ordered]@{ name = [string]$product.displayName; productState = [int]$product.productState }
}
$out.products = @($products)
$out | ConvertTo-Json -Depth 4 -Compress
`

// scanScript runs the scan and reports only what this scan turned up: the
// detections recorded after it started. Defender keeps its full history
// forever, so an unfiltered list would re-report years-old finds as new.
const scanScript = `
$ErrorActionPreference = 'Stop'
$started = (Get-Date).ToUniversalTime()
Start-MpScan -ScanType %s
$names = @{}
foreach ($threat in @(Get-MpThreat)) { $names[[string]$threat.ThreatID] = $threat }
$threats = @()
foreach ($detection in @(Get-MpThreatDetection)) {
  if (-not $detection.InitialDetectionTime) { continue }
  if ($detection.InitialDetectionTime.ToUniversalTime() -lt $started) { continue }
  $known = $names[[string]$detection.ThreatID]
  $threats += [ordered]@{
    name        = if ($known) { [string]$known.ThreatName } else { "ThreatID $($detection.ThreatID)" }
    severityId  = if ($known) { [int]$known.SeverityID } else { 0 }
    statusId    = [int]$detection.ThreatStatusID
    detectedAt  = $detection.InitialDetectionTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    processName = [string]$detection.ProcessName
  }
}
@{ threats = @($threats) } | ConvertTo-Json -Depth 4 -Compress
`

func runPowerShell(script string, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	command := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive",
		"-ExecutionPolicy", "Bypass", "-Command", script)
	output, err := command.Output()
	if ctx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("délai dépassé après %s", timeout)
	}
	if err != nil {
		var exitError *exec.ExitError
		if errors.As(err, &exitError) && len(exitError.Stderr) > 0 {
			return nil, fmt.Errorf("%s", strings.TrimSpace(string(exitError.Stderr)))
		}
		return nil, err
	}
	return output, nil
}

// Status reports antivirus health for this host.
func Status() (map[string]any, error) {
	output, err := runPowerShell(statusScript, statusTimeout)
	if err != nil {
		return nil, fmt.Errorf("lecture de l'état antivirus impossible: %w", err)
	}

	var raw rawStatus
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		// Nothing answered at all: report "no antivirus" rather than an error,
		// which is a finding the dashboard can act on.
		return rollUp(emptyStatus(time.Now())), nil
	}
	if err := json.Unmarshal([]byte(trimmed), &raw); err != nil {
		return nil, fmt.Errorf("réponse antivirus illisible: %w", err)
	}
	return buildStatus(raw, time.Now()), nil
}

// Scan runs a Defender scan now and reports what it found. It blocks: a full
// scan can take hours, which is why the dashboard gives this command type a
// longer stale window than the rest.
func Scan(scanType string) (map[string]any, error) {
	normalized, err := normalizeScanType(scanType)
	if err != nil {
		return nil, err
	}

	defenderType, timeout := "QuickScan", quickScanTimeout
	if normalized == "full" {
		defenderType, timeout = "FullScan", fullScanTimeout
	}

	logs.Append("[antivirus] scan %s started", normalized)
	started := time.Now()
	output, err := runPowerShell(fmt.Sprintf(scanScript, defenderType), timeout)
	if err != nil {
		return nil, fmt.Errorf("scan antivirus échoué: %w", err)
	}

	var payload struct {
		Threats []rawThreat `json:"threats"`
	}
	trimmed := strings.TrimSpace(string(output))
	if trimmed != "" {
		if err := json.Unmarshal([]byte(trimmed), &payload); err != nil {
			return nil, fmt.Errorf("résultat de scan illisible: %w", err)
		}
	}

	finished := time.Now()
	logs.Append("[antivirus] scan %s finished: %d threat(s)", normalized, len(payload.Threats))
	return buildScanResult(normalized, "Microsoft Defender", started, finished, payload.Threats), nil
}
