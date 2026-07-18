package output

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseFormat(t *testing.T) {
	cases := map[string]struct {
		want    Format
		wantErr bool
	}{
		"text":        {want: FormatText},
		"json":        {want: FormatJSON},
		"json-pretty": {want: FormatJSONPretty},
		"":            {wantErr: true},
		"JSON":        {wantErr: true},
		"yaml":        {wantErr: true},
	}
	for raw, tc := range cases {
		got, err := ParseFormat(raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseFormat(%q): expected error, got nil", raw)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseFormat(%q): unexpected error: %v", raw, err)
			continue
		}
		if got != tc.want {
			t.Errorf("ParseFormat(%q) = %q, want %q", raw, got, tc.want)
		}
	}
}

func TestParseFormatErrorListsValues(t *testing.T) {
	_, err := ParseFormat("bogus")
	if err == nil {
		t.Fatal("expected error")
	}
	for _, v := range ValidValues() {
		if !strings.Contains(err.Error(), v) {
			t.Errorf("error %q does not mention valid value %q", err.Error(), v)
		}
	}
}

func TestIsJSON(t *testing.T) {
	if FormatText.IsJSON() {
		t.Error("text should not be JSON")
	}
	if !FormatJSON.IsJSON() || !FormatJSONPretty.IsJSON() {
		t.Error("json and json-pretty should be JSON")
	}
}

func TestJSONCompact(t *testing.T) {
	var buf bytes.Buffer
	if err := FormatJSON.JSON(&buf, map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != "{\"a\":1}\n" {
		t.Errorf("compact JSON = %q, want %q", got, "{\"a\":1}\n")
	}
}

func TestJSONPrettyIndents(t *testing.T) {
	var buf bytes.Buffer
	if err := FormatJSONPretty.JSON(&buf, map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); !strings.Contains(got, "\n  \"a\": 1") {
		t.Errorf("pretty JSON = %q, want indented", got)
	}
}

func TestJSONDoesNotEscapeHTML(t *testing.T) {
	var buf bytes.Buffer
	if err := FormatJSON.JSON(&buf, map[string]string{"url": "https://x/?a=1&b=2"}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), "\\u0026") {
		t.Errorf("expected literal &, got %q", buf.String())
	}
}
