package packages

import (
	"strings"
	"testing"
)

// toCRLF rewrites a fixture with Windows line endings.
//
// Every table test runs through this as well as on the raw LF form. The
// fixtures were LF-only for a Windows-only program, and that hid a bug that
// emptied every line of every real winget table: the tests passed while the
// feature had never once worked on a real machine.
func toCRLF(text string) string {
	return strings.ReplaceAll(text, "\n", "\r\n")
}

// Real `winget list` output, English UI, including the leading progress spinner
// line winget writes to stdout before the table.
const wingetListEN = "   \r  - \r  \\ \r" + `
Name                           Id                            Version      Available Source
-------------------------------------------------------------------------------------------
7-Zip 24.09 (x64)              7zip.7zip                     24.09        24.10     winget
Git                            Git.Git                       2.47.0       2.48.1    winget
Microsoft Edge                 Microsoft.Edge                131.0.2903.9           winget
Mozilla Firefox (x64 fr)       Mozilla.Firefox               133.0                  winget
`

// Same command on a French Windows: headers are translated, so column positions
// must come from the header row and never from hard-coded labels.
const wingetListFR = `
Nom                            ID                            Version      Disponible Source
--------------------------------------------------------------------------------------------
Notepad++ (64-bit x64)         Notepad++.Notepad++           8.7.1        8.7.5      winget
VLC media player               VideoLAN.VLC                  3.0.21                  winget

3 mises à niveau disponibles.
`

func TestParseTableEnglish(t *testing.T) {
	rows := ParseTable(wingetListEN)
	if len(rows) != 4 {
		t.Fatalf("expected 4 rows, got %d: %#v", len(rows), rows)
	}
	if got := rows[0].Get(0); got != "7-Zip 24.09 (x64)" {
		t.Errorf("name = %q", got)
	}
	if got := rows[0].Get(1); got != "7zip.7zip" {
		t.Errorf("id = %q", got)
	}
	if got := rows[0].Get(2); got != "24.09" {
		t.Errorf("version = %q", got)
	}
	if got := rows[0].Get(3); got != "24.10" {
		t.Errorf("available = %q", got)
	}
	// A package with no available upgrade leaves that column empty.
	if got := rows[2].Get(3); got != "" {
		t.Errorf("expected empty available column, got %q", got)
	}
	if got := rows[2].Get(4); got != "winget" {
		t.Errorf("source = %q", got)
	}
}

func TestParseTableLocalisedHeaders(t *testing.T) {
	rows := ParseTable(wingetListFR)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %#v", len(rows), rows)
	}
	if got := rows[0].Get(1); got != "Notepad++.Notepad++" {
		t.Errorf("id = %q", got)
	}
	if got := rows[1].Get(1); got != "VideoLAN.VLC" {
		t.Errorf("id = %q", got)
	}
}

// The trailing "N mises à niveau disponibles." line only fills the first column
// and must not be mistaken for a package.
func TestParseTableIgnoresSummaryLine(t *testing.T) {
	for _, row := range ParseTable(wingetListFR) {
		if row.Get(0) == "3 mises à niveau disponibles." {
			t.Fatal("summary line was parsed as a package")
		}
	}
}

func TestParseTableWithoutTable(t *testing.T) {
	if rows := ParseTable("No installed package found matching input criteria.\n"); rows != nil {
		t.Errorf("expected no rows, got %#v", rows)
	}
	if rows := ParseTable(""); rows != nil {
		t.Errorf("expected no rows for empty output, got %#v", rows)
	}
}

func TestCleanLineKeepsFinalRedraw(t *testing.T) {
	if got := cleanLine("  -\r  \\\rGit    Git.Git"); got != "Git    Git.Git" {
		t.Errorf("cleanLine = %q", got)
	}
}

// A locale whose header uses two words must not gain a phantom column: the
// space inside "Version disponible" sits where data rows carry version digits,
// so it fails the blank-on-every-line check.
func TestParseTableTwoWordHeader(t *testing.T) {
	const output = `
Nom                  ID                   Version installée  Source
-------------------------------------------------------------------
Notepad++            Notepad++.Notepad++  8.7.1              winget
VLC                  VideoLAN.VLC         3.0.21             winget
`
	rows := ParseTable(output)
	if len(rows) != 2 {
		t.Fatalf("expected 2 rows, got %d: %#v", len(rows), rows)
	}
	if got := len(rows[0]); got != 4 {
		t.Fatalf("expected 4 columns, got %d: %#v", got, rows[0])
	}
	if got := rows[0].Get(2); got != "8.7.1" {
		t.Errorf("version = %q", got)
	}
	if got := rows[0].Get(3); got != "winget" {
		t.Errorf("source = %q", got)
	}
}

// The dashboard shows "no packages" exactly like "you have not run this yet",
// so the agent must be able to tell an empty table apart from output it could
// not read at all.
func TestParseTableResultDistinguishesEmptyFromUnreadable(t *testing.T) {
	// A real table with no data rows: a legitimate empty answer.
	const emptyTable = `
Name        Id          Version
-------------------------------
`
	rows, sawTable := ParseTableResult(emptyTable)
	if !sawTable {
		t.Error("a header plus a rule is a table, even with no rows")
	}
	if len(rows) != 0 {
		t.Errorf("expected no rows, got %#v", rows)
	}

	// Output with no table at all: something else happened.
	for _, output := range []string{
		"No installed package found matching input criteria.\n",
		"Impossible de se connecter a la source.\n",
		"",
	} {
		if _, sawTable := ParseTableResult(output); sawTable {
			t.Errorf("%q should not be reported as a table", output)
		}
	}

	// And a normal table still parses.
	if rows, sawTable := ParseTableResult(wingetListEN); !sawTable || len(rows) != 4 {
		t.Errorf("sawTable=%v rows=%d", sawTable, len(rows))
	}
}

// winget writes CRLF. This is the regression test for the line-ending bug that
// made every table unparseable on a real machine while the LF fixtures passed.
func TestParseTableHandlesWindowsLineEndings(t *testing.T) {
	for name, fixture := range map[string]string{
		"english": wingetListEN,
		"french":  wingetListFR,
	} {
		t.Run(name, func(t *testing.T) {
			lf := ParseTable(fixture)
			crlf, sawTable := ParseTableResult(toCRLF(fixture))
			if !sawTable {
				t.Fatal("no table found in CRLF output -- every line was emptied")
			}
			if len(crlf) != len(lf) {
				t.Fatalf("CRLF gave %d rows, LF gave %d", len(crlf), len(lf))
			}
			for index := range lf {
				for column := range lf[index] {
					if lf[index].Get(column) != crlf[index].Get(column) {
						t.Errorf("row %d column %d: LF %q vs CRLF %q",
							index, column, lf[index].Get(column), crlf[index].Get(column))
					}
				}
			}
		})
	}
}

// A progress redraw inside a line must still be resolved once the CRLF
// terminator has been removed.
func TestCleanLineHandlesRedrawAndCRLFTogether(t *testing.T) {
	if got := cleanLine("  -\r  \\\rGit    Git.Git\r"); got != "Git    Git.Git" {
		t.Errorf("cleanLine = %q", got)
	}
	if got := cleanLine("Steam   Valve.Steam\r"); got != "Steam   Valve.Steam" {
		t.Errorf("plain CRLF line = %q", got)
	}
}

// A table captured from a real Windows 11 machine, reduced but keeping the
// cases that break naive parsing:
//
//   - Ids containing spaces, which rule out splitting on whitespace and are why
//     columns are read by offset;
//   - a Source column empty on some rows but not all, so it must be kept;
//   - a very long Id that pushes the later columns far to the right.
const wingetListRealMachine = `
Nom                                                     Id                                                             Version        Source
--------------------------------------------------------------------------------------------------------------------------------------------
Microsoft ASP.NET Core 8.0.30 - Shared Framework (x64)  Microsoft.DotNet.AspNetCore.8                                  8.0.30         winget
Microsoft Edge                                          Microsoft.Edge                                                 152.0.4191.53  winget
Microsoft.WindowsNotepad                                MSIX\Microsoft.WindowsNotepad_11.2607.14.0_x64__8wekyb3d8bbwe  11.2607.14.0
Mozilla Firefox (x64 fr)                                ARP\Machine\X64\Mozilla Firefox                                154.0.1
Parsec Virtual Display Driver                           Parsec.ParsecVDD                                               0.45.0.0       winget
Steam                                                   Valve.Steam                                                    2.10.91.91     winget
World of Slime Demo                                     ARP\Machine\X64\Steam App 4793900                              Unknown
`

func TestParseTableFromARealMachine(t *testing.T) {
	for name, output := range map[string]string{
		"lf":   wingetListRealMachine,
		"crlf": toCRLF(wingetListRealMachine),
	} {
		t.Run(name, func(t *testing.T) {
			rows, sawTable := ParseTableResult(output)
			if !sawTable {
				t.Fatal("no table found")
			}
			if len(rows) != 7 {
				t.Fatalf("expected 7 rows, got %d: %#v", len(rows), rows)
			}

			// An Id carrying spaces must survive intact: it is what install and
			// uninstall are given.
			if got := rows[3].Get(1); got != `ARP\Machine\X64\Mozilla Firefox` {
				t.Errorf("id with spaces = %q", got)
			}
			if got := rows[3].Get(2); got != "154.0.1" {
				t.Errorf("version = %q", got)
			}
			// Empty Source on that row, present on others: the column stays.
			if got := rows[3].Get(3); got != "" {
				t.Errorf("expected an empty source, got %q", got)
			}
			if got := rows[5].Get(3); got != "winget" {
				t.Errorf("source = %q", got)
			}
			// A name containing " - " and parentheses is not a column boundary.
			if got := rows[0].Get(0); got != "Microsoft ASP.NET Core 8.0.30 - Shared Framework (x64)" {
				t.Errorf("name = %q", got)
			}
			if got := rows[6].Get(1); got != `ARP\Machine\X64\Steam App 4793900` {
				t.Errorf("id = %q", got)
			}
		})
	}
}
