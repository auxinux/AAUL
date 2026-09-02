package packages

import "testing"

func TestValidateNameAcceptsWingetIds(t *testing.T) {
	valid := []string{"Mozilla.Firefox", "7zip.7zip", "Microsoft.VisualStudioCode", "Git.Git", "openssl@3"}
	for _, name := range valid {
		if _, err := validateName(name); err != nil {
			t.Errorf("%q should be accepted: %v", name, err)
		}
	}
}

// Every rejection here is a name that could otherwise reach a command line.
// The arguments are passed as a fixed list so none of these could actually be
// interpreted as syntax — this is the second layer, not the only one.
func TestValidateNameRejectsUnsafeInput(t *testing.T) {
	invalid := []string{
		"", " ", "-starts-with-dash",
		"pkg; shutdown /r", "pkg && del", "pkg | more",
		`C:\payload.msi`, "http://example.com/x.exe",
		"{90160000-000F-0000-1000-0000000FF1CE}",
		"pkg name with spaces",
	}
	for _, name := range invalid {
		if _, err := validateName(name); err == nil {
			t.Errorf("%q should have been rejected", name)
		}
	}
}

func TestBlacklistedNamesAreRefused(t *testing.T) {
	for _, name := range []string{"grub", "systemd", "linux-image-generic", "sudo", "GRUB2"} {
		if !IsBlacklisted(name) {
			t.Errorf("%q should be blacklisted", name)
		}
		if _, err := validateName(name); err == nil {
			t.Errorf("%q should have been refused by validateName", name)
		}
	}
	for _, name := range []string{"Mozilla.Firefox", "Git.Git"} {
		if IsBlacklisted(name) {
			t.Errorf("%q should not be blacklisted", name)
		}
	}
}

func TestValidateQuery(t *testing.T) {
	if _, err := validateQuery("visual studio code"); err != nil {
		t.Errorf("a multi-word query should be accepted: %v", err)
	}
	for _, query := range []string{"", "a;b", "a`b", "a$(b)"} {
		if _, err := validateQuery(query); err == nil {
			t.Errorf("%q should have been rejected", query)
		}
	}
}

func TestUpdatePackagesRejectsEmptyList(t *testing.T) {
	if _, err := UpdatePackages(nil); err == nil {
		t.Error("an empty package list should be refused")
	}
}

func TestPackageVersionFromPath(t *testing.T) {
	const path = `C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.24.25200.0_x64__8wekyb3d8bbwe\winget.exe`
	if got := packageVersionFromPath(path); got != "1.24.25200.0" {
		t.Errorf("version = %q", got)
	}
}

func TestCompareVersionsPicksNewestStagedPackage(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"1.24.25200.0", "1.22.10661.0", 1},
		{"1.22.10661.0", "1.24.25200.0", -1},
		{"1.24.25200.0", "1.24.25200.0", 0},
		// A shorter version is not automatically older.
		{"1.25", "1.24.25200.0", 1},
		{"", "1.0", -1},
	}
	for _, testCase := range cases {
		if got := compareVersions(testCase.left, testCase.right); got != testCase.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d",
				testCase.left, testCase.right, got, testCase.want)
		}
	}
}
