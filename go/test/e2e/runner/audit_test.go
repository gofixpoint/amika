package runner

import (
	"errors"
	"strings"
	"testing"
)

func TestAuditRowsReadOldestFirstWithOneOutcomeEach(t *testing.T) {
	// Cleanup results arrive newest first; the audit reverses them.
	results := []CleanupResult{
		{Entry: Entry{Type: "snapshot", Name: "snap-3", CreatedByStep: "capture"}, Verified: VerifiedStillPresent, Err: errors.New("still listed after delete")},
		{Entry: Entry{Type: "sandbox", Name: "sb-2", CreatedByStep: "create second"}, Verified: VerifiedUnsupported},
		{Entry: Entry{Type: "sandbox", Name: "sb-1", CreatedByStep: "create first"}, Verified: VerifiedGone},
	}
	rows := AuditRows("api-lifecycle", results)
	want := []AuditRow{
		{Case: "api-lifecycle", Type: "sandbox", Name: "sb-1", CreatedByStep: "create first", Outcome: OutcomeDeleted},
		{Case: "api-lifecycle", Type: "sandbox", Name: "sb-2", CreatedByStep: "create second", Outcome: OutcomeDeletedUnverified},
		{Case: "api-lifecycle", Type: "snapshot", Name: "snap-3", CreatedByStep: "capture", Outcome: OutcomeLeaked, Detail: "still listed after delete"},
	}
	if len(rows) != len(want) {
		t.Fatalf("got %d rows, want %d: %+v", len(rows), len(want), rows)
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Fatalf("row %d = %+v, want %+v", i, rows[i], want[i])
		}
	}
	if leaked := LeakedRows(rows); len(leaked) != 1 || leaked[0].Name != "snap-3" {
		t.Fatalf("expected only snap-3 leaked, got %+v", leaked)
	}
}

func TestRenderAuditTextAlignsColumnsAndEndsWithTotals(t *testing.T) {
	rows := []AuditRow{
		{Case: "api-x", Type: "sandbox", Name: "sb-1", CreatedByStep: "create", Outcome: OutcomeDeleted},
		{Case: "api-x", Type: "ssh-key", Name: "k1", CreatedByStep: "push key", Outcome: OutcomeLeaked, Detail: "exit status 1"},
	}
	got := RenderAuditText(rows, "run-1", "/runs")
	want := strings.Join([]string{
		"E2E resource audit  run=run-1",
		"CASE   TYPE     NAME  CREATED BY  OUTCOME",
		"api-x  sandbox  sb-1  create      deleted",
		"api-x  ssh-key  k1    push key    LEAKED: exit status 1",
		"2 created, 1 deleted, 1 LEAKED",
		"",
		"Ledgers: /runs",
		"",
	}, "\n")
	if got != want {
		t.Fatalf("text audit:\n%s\nwant:\n%s", got, want)
	}
}

func TestRenderAuditTextWithNoRows(t *testing.T) {
	got := RenderAuditText(nil, "run-1", "/runs")
	if !strings.Contains(got, "No resources were created.") || !strings.Contains(got, "0 created, 0 deleted, 0 leaked") {
		t.Fatalf("unexpected empty audit:\n%s", got)
	}
}

func TestRenderAuditMarkdownEscapesPipes(t *testing.T) {
	rows := []AuditRow{
		{Case: "api-x", Type: "sandbox", Name: "sb-1", CreatedByStep: "create", Outcome: OutcomeLeaked, Detail: "a | b"},
	}
	got := RenderAuditMarkdown(rows, "run-1")
	for _, want := range []string{
		"| CASE | TYPE | NAME | CREATED BY | OUTCOME |",
		"| --- | --- | --- | --- | --- |",
		`| api-x | sandbox | sb-1 | create | LEAKED: a \| b |`,
		"1 created, 0 deleted, 1 LEAKED",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("markdown audit missing %q:\n%s", want, got)
		}
	}
}
