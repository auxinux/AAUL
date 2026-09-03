package packages

import (
	"strings"
)

// winget has no machine-readable output for `list`, `search` or `upgrade`, so
// its fixed-width tables have to be parsed. The layout is:
//
//	Name                 Id                Version   Available  Source
//	-------------------------------------------------------------------
//	7-Zip 24.09          7zip.7zip         24.09     24.10      winget
//
// Column positions are taken from the header row rather than from hard-coded
// labels, because winget localises its headers ("Nom", "Version disponible")
// and the agent must work on any Windows UI language.
//
// The Python agent skipped all of this and reported each raw line as a package
// name, which made every winget row unusable as an install target — install and
// uninstall take a package Id (`winget install --id`).

// Row is one parsed table row, indexed by column position.
type Row []string

// Get returns the column at index, or "" when the row is shorter.
func (r Row) Get(index int) string {
	if index < 0 || index >= len(r) {
		return ""
	}
	return r[index]
}

// cleanLine strips the carriage-return progress redraws and the spinner
// characters winget emits while it queries its sources. Only the final state of
// a redrawn line is kept.
//
// The order matters, and getting it wrong cost a release. Lines arrive as CRLF,
// so after splitting on "\n" every line ends with a lone "\r". Looking for the
// last "\r" first therefore found the line terminator and kept everything after
// it -- nothing -- which emptied every single line of every winget table. The
// terminator is removed first, and only then is an in-line redraw resolved.
func cleanLine(line string) string {
	line = strings.TrimSuffix(line, "\r")
	if index := strings.LastIndex(line, "\r"); index >= 0 {
		line = line[index+1:]
	}
	cleaned := strings.Map(func(r rune) rune {
		// Backspace and the block-drawing characters used by the progress bar
		// carry no information once the operation has finished.
		if r == '\b' || r == '█' || r == '░' || (r < 32 && r != '\t') {
			return -1
		}
		return r
	}, line)
	return strings.TrimRight(cleaned, " \t")
}

// isSeparator reports whether a line is the dashed rule under the header.
func isSeparator(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len([]rune(trimmed)) < 10 {
		return false
	}
	for _, r := range trimmed {
		if r != '-' && r != '─' {
			return false
		}
	}
	return true
}

// columnOffsets derives the rune index at which each column starts.
//
// Candidate starts come from the header row alone, accepting a single blank as
// a separator — winget's `Available Source` pair is only one space apart, so a
// "two or more spaces" rule silently merges those two columns.
//
// A single-blank rule applied to the header alone would split a translated
// two-word header, so each candidate is then confirmed against the data rows:
// the position before a real column start is blank on every line of the table.
// That is the defining property of a fixed-width column, and a space inside a
// header label fails it as soon as any row has data there.
func columnOffsets(lines [][]rune) []int {
	if len(lines) == 0 {
		return nil
	}
	header := lines[0]

	blankEverywhere := func(position int) bool {
		for _, line := range lines {
			// Past the end of a line counts as blank: trailing columns are
			// simply empty on that row.
			if position < len(line) && line[position] != ' ' {
				return false
			}
		}
		return true
	}

	offsets := []int{}
	for position := 0; position < len(header); position++ {
		if header[position] == ' ' {
			continue
		}
		if position == 0 {
			offsets = append(offsets, 0)
			continue
		}
		if header[position-1] == ' ' && blankEverywhere(position-1) {
			offsets = append(offsets, position)
		}
	}
	return offsets
}

// ParseTable extracts the data rows of a winget table, discarding whether a
// table was present at all. Callers that need to tell "nothing to report" apart
// from "output we could not parse" should use ParseTableResult.
func ParseTable(output string) []Row {
	rows, _ := ParseTableResult(output)
	return rows
}

// ParseTableResult extracts the data rows and reports whether a table was found.
//
// The distinction matters. "winget upgrade" legitimately prints no table when
// nothing needs upgrading, but "winget list" always has one -- so an absent
// table there means the output was something else entirely (an error, another
// encoding, a prompt) and returning an empty list would hide the problem behind
// a screen that looks exactly like "you have not clicked yet".
//
// Values are sliced by rune offset. A name containing double-width characters
// can therefore bleed into the next column — best effort, and far better than
// treating the whole line as a package name.
func ParseTableResult(output string) ([]Row, bool) {
	lines := strings.Split(output, "\n")
	for index := range lines {
		lines[index] = cleanLine(lines[index])
	}

	separator := -1
	for index, line := range lines {
		if isSeparator(line) {
			separator = index
			break
		}
	}
	// No table at all: winget printed an error or "no installed package found".
	if separator < 1 {
		return nil, false
	}

	// The table ends at the first blank line. What follows is winget's summary
	// ("3 upgrades available."), which is not a row and must not be parsed as
	// one — nor be allowed to disturb the column boundaries.
	body := [][]rune{[]rune(lines[separator-1])}
	for _, line := range lines[separator+1:] {
		if strings.TrimSpace(line) == "" {
			break
		}
		body = append(body, []rune(line))
	}
	if len(body) < 2 {
		// A header and a rule, but no rows: a real, empty table.
		return nil, true
	}

	offsets := columnOffsets(body)
	if len(offsets) == 0 {
		return nil, false
	}

	rows := []Row{}
	for _, runes := range body[1:] {
		row := make(Row, 0, len(offsets))
		for position, start := range offsets {
			end := len(runes)
			if position+1 < len(offsets) && offsets[position+1] < end {
				end = offsets[position+1]
			}
			if start >= len(runes) {
				row = append(row, "")
				continue
			}
			row = append(row, strings.TrimSpace(string(runes[start:end])))
		}
		// A row with no name or no Id is not a package.
		if row.Get(0) == "" || row.Get(1) == "" {
			continue
		}
		rows = append(rows, row)
	}
	return dropEmptyColumns(rows), true
}

// dropEmptyColumns removes columns that are blank on every row.
//
// A translated header whose label contains a space can still produce a phantom
// column when no data value reaches into that space. The phantom is empty by
// construction, and removing it keeps the remaining columns at the positions
// callers expect (name, id, version, ...).
func dropEmptyColumns(rows []Row) []Row {
	if len(rows) == 0 {
		return rows
	}
	width := 0
	for _, row := range rows {
		if len(row) > width {
			width = len(row)
		}
	}
	keep := []int{}
	for column := 0; column < width; column++ {
		for _, row := range rows {
			if row.Get(column) != "" {
				keep = append(keep, column)
				break
			}
		}
	}
	compacted := make([]Row, 0, len(rows))
	for _, row := range rows {
		trimmed := make(Row, 0, len(keep))
		for _, column := range keep {
			trimmed = append(trimmed, row.Get(column))
		}
		compacted = append(compacted, trimmed)
	}
	return compacted
}
