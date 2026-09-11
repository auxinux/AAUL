package antivirus

import (
	"testing"
	"time"
)

func intPtr(value int) *int { return &value }

func TestDecodeProductStateReadsSecurityCenterBitmask(t *testing.T) {
	cases := []struct {
		name     string
		state    int
		enabled  bool
		upToDate bool
	}{
		{"enabled and current", 0x061000, true, true},
		{"enabled but outdated", 0x061010, true, false},
		{"disabled", 0x060900, false, true},
		{"disabled and outdated", 0x060910, false, false},
	}
	for _, testCase := range cases {
		enabled, upToDate := decodeProductState(testCase.state)
		if enabled != testCase.enabled || upToDate != testCase.upToDate {
			t.Errorf("%s: got enabled=%v upToDate=%v, want %v/%v",
				testCase.name, enabled, upToDate, testCase.enabled, testCase.upToDate)
		}
	}
}

func TestBuildStatusHealthyDefender(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent:           true,
		AMServiceEnabled:          true,
		AntivirusEnabled:          true,
		RealTimeProtectionEnabled: true,
		SignatureVersion:          "1.403.1234.0",
		SignatureAge:              intPtr(1),
		QuickScanEndTime:          "2026-09-10T08:00:00Z",
	}, time.Now())

	if healthy, _ := status["healthy"].(bool); !healthy {
		t.Fatalf("expected healthy, issues: %v", status["issues"])
	}
	if status["product"] != "Microsoft Defender" {
		t.Errorf("product = %v", status["product"])
	}
	if status["lastScanType"] != "quick" {
		t.Errorf("lastScanType = %v", status["lastScanType"])
	}
	if scanSupported, _ := status["scanSupported"].(bool); !scanSupported {
		t.Error("Defender must advertise scan support")
	}
}

func TestBuildStatusFlagsStaleSignaturesAndRealtimeOff(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent:           true,
		AMServiceEnabled:          true,
		AntivirusEnabled:          true,
		RealTimeProtectionEnabled: false,
		SignatureAge:              intPtr(30),
	}, time.Now())

	if healthy, _ := status["healthy"].(bool); healthy {
		t.Fatal("expected unhealthy")
	}
	issues, _ := status["issues"].([]string)
	if len(issues) != 2 {
		t.Fatalf("expected 2 issues, got %v", issues)
	}
}

func TestBuildStatusCountsThreats(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent:           true,
		AMServiceEnabled:          true,
		AntivirusEnabled:          true,
		RealTimeProtectionEnabled: true,
		SignatureAge:              intPtr(0),
		Threats: []rawThreat{
			{Name: "Virus:DOS/EICAR_Test_File", SeverityID: 4, StatusID: 3, DetectedAt: "2026-09-09T12:00:00Z"},
		},
	}, time.Now())

	if status["threatsFound"] != 1 {
		t.Fatalf("threatsFound = %v", status["threatsFound"])
	}
	threats, _ := status["threats"].([]map[string]any)
	if len(threats) != 1 || threats[0]["severity"] != "severe" || threats[0]["action"] != "quarantined" {
		t.Fatalf("threat mapping wrong: %v", threats)
	}
	if healthy, _ := status["healthy"].(bool); healthy {
		t.Error("a detected threat must make the host unhealthy")
	}
}

// A third-party suite switches Defender off — the machine is still protected,
// and reporting "no antivirus" there would be a false alarm.
func TestBuildStatusPrefersActiveThirdPartyProduct(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent:  true,
		AMServiceEnabled: true,
		AntivirusEnabled: false,
		Products: []rawProduct{
			{Name: "Windows Defender", ProductState: 0x060900},
			{Name: "Bitdefender Antivirus", ProductState: 0x061000},
		},
	}, time.Now())

	if status["product"] != "Bitdefender Antivirus" {
		t.Fatalf("product = %v", status["product"])
	}
	if installed, _ := status["installed"].(bool); !installed {
		t.Error("expected installed")
	}
	if scanSupported, _ := status["scanSupported"].(bool); scanSupported {
		t.Error("AAUL cannot drive a third-party scanner")
	}
	if healthy, _ := status["healthy"].(bool); !healthy {
		t.Errorf("expected healthy, issues: %v", status["issues"])
	}
}

func TestBuildStatusWithNothingInstalled(t *testing.T) {
	status := buildStatus(rawStatus{}, time.Now())
	if installed, _ := status["installed"].(bool); installed {
		t.Fatal("expected not installed")
	}
	issues, _ := status["issues"].([]string)
	if len(issues) != 1 || issues[0] != "Aucun antivirus détecté" {
		t.Fatalf("issues = %v", issues)
	}
}

func TestLatestScanPicksMostRecent(t *testing.T) {
	at, kind := latestScan("2026-09-01T08:00:00Z", "2026-09-09T08:00:00Z")
	if kind != "full" || at != "2026-09-09T08:00:00Z" {
		t.Errorf("got %s/%s", at, kind)
	}
	if _, kind := latestScan("2026-09-10T08:00:00Z", ""); kind != "quick" {
		t.Errorf("quick-only should win, got %s", kind)
	}
	if at, kind := latestScan("", ""); at != "" || kind != "" {
		t.Errorf("no scan should stay empty, got %s/%s", at, kind)
	}
}

func TestNormalizeScanType(t *testing.T) {
	for _, valid := range []string{"", "quick", "QUICK", " full "} {
		if _, err := normalizeScanType(valid); err != nil {
			t.Errorf("%q should be accepted: %v", valid, err)
		}
	}
	if _, err := normalizeScanType("rm -rf /"); err == nil {
		t.Error("an unknown scan type must be rejected")
	}
}

func TestBuildScanResultReportsInfectedWhenThreatsFound(t *testing.T) {
	started := time.Date(2026, 9, 10, 8, 0, 0, 0, time.UTC)
	result := buildScanResult("quick", "Microsoft Defender", started, started.Add(90*time.Second),
		[]rawThreat{{Name: "EICAR", SeverityID: 4, StatusID: 2}})

	if result["status"] != "infected" || result["threatsFound"] != 1 {
		t.Fatalf("result = %v", result)
	}
	if result["durationSeconds"] != 90 {
		t.Errorf("durationSeconds = %v", result["durationSeconds"])
	}
}

func TestRealtimeFixableWhenDefenderRealtimeOff(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent: true, AMServiceEnabled: true, AntivirusEnabled: true,
		RealTimeProtectionEnabled: false, SignatureAge: intPtr(0),
	}, time.Now())
	if fixable, _ := status["realtimeFixable"].(bool); !fixable {
		t.Fatal("Defender with real-time off must be offered the fix")
	}
}

func TestRealtimeNotFixableUnderGroupPolicy(t *testing.T) {
	status := buildStatus(rawStatus{
		DefenderPresent: true, AMServiceEnabled: true, AntivirusEnabled: true,
		RealTimeProtectionEnabled: false, RealtimePolicyDisabled: true, SignatureAge: intPtr(0),
	}, time.Now())
	if fixable, _ := status["realtimeFixable"].(bool); fixable {
		t.Fatal("a Group Policy decision must not be overridden from the dashboard")
	}
}

func TestRealtimeNotFixableWhenAlreadyOnOrThirdParty(t *testing.T) {
	on := buildStatus(rawStatus{
		DefenderPresent: true, AMServiceEnabled: true, AntivirusEnabled: true,
		RealTimeProtectionEnabled: true, SignatureAge: intPtr(0),
	}, time.Now())
	if fixable, _ := on["realtimeFixable"].(bool); fixable {
		t.Error("nothing to fix when real-time protection is already on")
	}
	thirdParty := buildStatus(rawStatus{
		DefenderPresent: true, AMServiceEnabled: true,
		Products: []rawProduct{{Name: "Bitdefender Antivirus", ProductState: 0x061000}},
	}, time.Now())
	if fixable, _ := thirdParty["realtimeFixable"].(bool); fixable {
		t.Error("AAUL cannot switch a third-party product's real-time protection")
	}
}

func TestEmptyStatusIsNeverFixable(t *testing.T) {
	if fixable, _ := buildStatus(rawStatus{}, time.Now())["realtimeFixable"].(bool); fixable {
		t.Error("no antivirus, nothing to switch on")
	}
}
