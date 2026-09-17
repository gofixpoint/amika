package cliprompt

import (
	"bufio"
	"strings"
	"testing"
)

func TestConfirm(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{name: "y", input: "y\n", want: true},
		{name: "yes", input: "yes\n", want: true},
		{name: "n", input: "n\n", want: false},
		{name: "no", input: "no\n", want: false},
		{name: "answer is case-insensitive", input: "YES\n", want: true},
		{name: "surrounding space is trimmed", input: "  y  \n", want: true},
		{name: "blank reprompts", input: "\nyes\n", want: true},
		{name: "unrecognized answer reprompts", input: "maybe\nno\n", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Confirm("Proceed?", bufio.NewReader(strings.NewReader(tt.input)))
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Fatalf("Confirm() = %v, want %v", got, tt.want)
			}
		})
	}
}

// A reader that ends without an answer must be an error, not a silent "no":
// the callers are destructive commands, and treating EOF as a decision would
// let one proceed (or abort) on input the user never gave.
func TestConfirmReadFailureIsAnError(t *testing.T) {
	if _, err := Confirm("Proceed?", bufio.NewReader(strings.NewReader(""))); err == nil {
		t.Fatal("expected an error when the reader has no answer to give")
	}
}
