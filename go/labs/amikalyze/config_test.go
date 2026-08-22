package amikalyze

import "testing"

func TestValidateConfig(t *testing.T) {
	tests := []struct {
		name    string
		config  Config
		wantErr bool
	}{
		{name: "valid", config: Config{Freezes: []Freeze{{Label: "database/schema-v1", Paths: []string{"schema/**/*.sql", "one.txt"}}}}},
		{name: "empty label", config: Config{Freezes: []Freeze{{Paths: []string{"one.txt"}}}}, wantErr: true},
		{name: "invalid label", config: Config{Freezes: []Freeze{{Label: "not valid", Paths: []string{"one.txt"}}}}, wantErr: true},
		{name: "duplicate label", config: Config{Freezes: []Freeze{{Label: "same", Paths: []string{"one"}}, {Label: "same", Paths: []string{"two"}}}}, wantErr: true},
		{name: "no paths", config: Config{Freezes: []Freeze{{Label: "empty"}}}, wantErr: true},
		{name: "absolute", config: Config{Freezes: []Freeze{{Label: "bad", Paths: []string{"/etc/passwd"}}}}, wantErr: true},
		{name: "parent", config: Config{Freezes: []Freeze{{Label: "bad", Paths: []string{"../secret"}}}}, wantErr: true},
		{name: "embedded doublestar", config: Config{Freezes: []Freeze{{Label: "bad", Paths: []string{"foo**bar"}}}}, wantErr: true},
		{name: "invalid class", config: Config{Freezes: []Freeze{{Label: "bad", Paths: []string{"[abc"}}}}, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfig(tt.config)
			if (err != nil) != tt.wantErr {
				t.Fatalf("validateConfig() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestMatchPattern(t *testing.T) {
	tests := []struct {
		pattern string
		name    string
		want    bool
	}{
		{"schema/**/*.sql", "schema/users.sql", true},
		{"schema/**/*.sql", "schema/v1/users.sql", true},
		{"schema/**/*.sql", "schema/v1/users.txt", false},
		{"vendor/**", "vendor/package/file.go", true},
		{"vendor/**", "vendor/file.go", true},
		{"*.txt", "one.txt", true},
		{"*.txt", "nested/one.txt", false},
		{"file?.txt", "file1.txt", true},
	}
	for _, tt := range tests {
		if got := matchPattern(tt.pattern, tt.name); got != tt.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", tt.pattern, tt.name, got, tt.want)
		}
	}
}
