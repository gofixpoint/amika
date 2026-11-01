package runner

import (
	"fmt"
	"strings"
)

// Audit outcomes. A row's Outcome is one of these.
const (
	// OutcomeDeleted: the cleanup command succeeded and the listing confirmed
	// the resource is gone.
	OutcomeDeleted = "deleted"
	// OutcomeDeletedUnverified: the cleanup command succeeded but the entry has
	// no verify_gone, so the listing was never asked.
	OutcomeDeletedUnverified = "deleted (unverified)"
	// OutcomeLeaked: the delete failed, or the listing still named the
	// resource. The row's Detail says which.
	OutcomeLeaked = "LEAKED"
)

// AuditRow is one resource a run created and what became of it. The run
// prints one row per resource when it ends, so a reader can see everything
// the run touched without opening the per-case files.
type AuditRow struct {
	Case          string `json:"case"`
	Type          string `json:"type"`
	Name          string `json:"name"`
	CreatedByStep string `json:"created_by_step"`
	Outcome       string `json:"outcome"`
	// Detail is the error for a leaked resource; empty otherwise.
	Detail string `json:"detail,omitempty"`
}

// AuditRows turns one case's cleanup results into audit rows, in the order
// the resources were created.
func AuditRows(caseName string, results []CleanupResult) []AuditRow {
	rows := make([]AuditRow, 0, len(results))
	// Cleanup runs newest first; the audit reads better oldest first.
	for i := len(results) - 1; i >= 0; i-- {
		res := results[i]
		row := AuditRow{
			Case:          caseName,
			Type:          res.Entry.Type,
			Name:          res.Entry.Name,
			CreatedByStep: res.Entry.CreatedByStep,
		}
		switch {
		case res.Err != nil:
			row.Outcome = OutcomeLeaked
			row.Detail = res.Err.Error()
		case res.Verified == VerifiedGone:
			row.Outcome = OutcomeDeleted
		default:
			row.Outcome = OutcomeDeletedUnverified
		}
		rows = append(rows, row)
	}
	return rows
}

// LeakedRows returns the rows whose resource may still exist.
func LeakedRows(rows []AuditRow) []AuditRow {
	var leaked []AuditRow
	for _, row := range rows {
		if row.Outcome == OutcomeLeaked {
			leaked = append(leaked, row)
		}
	}
	return leaked
}

var auditColumns = []struct {
	title string
	get   func(AuditRow) string
}{
	{"CASE", func(r AuditRow) string { return r.Case }},
	{"TYPE", func(r AuditRow) string { return r.Type }},
	{"NAME", func(r AuditRow) string { return r.Name }},
	{"CREATED BY", func(r AuditRow) string { return r.CreatedByStep }},
	{"OUTCOME", func(r AuditRow) string {
		if r.Detail != "" {
			return r.Outcome + ": " + r.Detail
		}
		return r.Outcome
	}},
}

// RenderAuditText renders the rows as an aligned table with a totals line,
// for stdout.
func RenderAuditText(rows []AuditRow, runID, runsRoot string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "E2E resource audit  run=%s\n", runID)
	if len(rows) == 0 {
		b.WriteString("No resources were created.\n")
	} else {
		cells := make([][]string, len(rows))
		widths := make([]int, len(auditColumns))
		for i, col := range auditColumns {
			widths[i] = len(col.title)
		}
		for r, row := range rows {
			cells[r] = make([]string, len(auditColumns))
			for i, col := range auditColumns {
				cells[r][i] = col.get(row)
				if len(cells[r][i]) > widths[i] {
					widths[i] = len(cells[r][i])
				}
			}
		}
		titles := make([]string, len(auditColumns))
		for i, col := range auditColumns {
			titles[i] = col.title
		}
		b.WriteString(padRow(titles, widths))
		for _, row := range cells {
			b.WriteString(padRow(row, widths))
		}
	}
	b.WriteString(auditTotals(rows))
	fmt.Fprintf(&b, "\nLedgers: %s\n", runsRoot)
	return b.String()
}

// RenderAuditMarkdown renders the rows as a markdown table, for a GitHub
// Actions step summary.
func RenderAuditMarkdown(rows []AuditRow, runID string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "### E2E resource audit (run `%s`)\n\n", runID)
	if len(rows) == 0 {
		b.WriteString("No resources were created.\n")
	} else {
		titles := make([]string, len(auditColumns))
		seps := make([]string, len(auditColumns))
		for i, col := range auditColumns {
			titles[i] = col.title
			seps[i] = "---"
		}
		fmt.Fprintf(&b, "| %s |\n| %s |\n", strings.Join(titles, " | "), strings.Join(seps, " | "))
		for _, row := range rows {
			cells := make([]string, len(auditColumns))
			for i, col := range auditColumns {
				cells[i] = strings.NewReplacer("|", `\|`, "\n", " ").Replace(col.get(row))
			}
			fmt.Fprintf(&b, "| %s |\n", strings.Join(cells, " | "))
		}
	}
	b.WriteString("\n" + auditTotals(rows))
	return b.String()
}

func padRow(cells []string, widths []int) string {
	parts := make([]string, len(cells))
	for i, cell := range cells {
		parts[i] = cell + strings.Repeat(" ", widths[i]-len(cell))
	}
	return strings.TrimRight(strings.Join(parts, "  "), " ") + "\n"
}

func auditTotals(rows []AuditRow) string {
	leaked := len(LeakedRows(rows))
	leakedWord := "0 leaked"
	if leaked > 0 {
		leakedWord = fmt.Sprintf("%d LEAKED", leaked)
	}
	return fmt.Sprintf("%d created, %d deleted, %s\n", len(rows), len(rows)-leaked, leakedWord)
}
