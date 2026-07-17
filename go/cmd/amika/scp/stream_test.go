package scpcmd

import "testing"

func TestPlanStreamTransfer(t *testing.T) {
	tests := []struct {
		name        string
		argv        []string
		wantStream  bool
		wantUpload  bool
		wantRecurse bool
		wantSandbox string
		wantRemote  string
		wantLocal   string
		wantErr     bool
	}{
		{
			name:        "upload local to sandbox (scp form, relative)",
			argv:        []string{"./a.txt", "mybox:my/f"},
			wantStream:  true,
			wantUpload:  true,
			wantSandbox: "mybox",
			wantRemote:  "/home/amika/my/f",
			wantLocal:   "./a.txt",
		},
		{
			name:        "upload via sbox uri, percent-decoded name, tilde path",
			argv:        []string{"/tmp/a", "sbox://dylan%2Fbox/~/a"},
			wantStream:  true,
			wantUpload:  true,
			wantSandbox: "dylan/box",
			wantRemote:  "/home/amika/a",
			wantLocal:   "/tmp/a",
		},
		{
			name:        "download sandbox to local",
			argv:        []string{"mybox:/etc/hosts", "./hosts"},
			wantStream:  true,
			wantUpload:  false,
			wantSandbox: "mybox",
			wantRemote:  "/etc/hosts",
			wantLocal:   "./hosts",
		},
		{
			name:        "recursive upload",
			argv:        []string{"-r", "./dir", "mybox:/srv"},
			wantStream:  true,
			wantUpload:  true,
			wantRecurse: true,
			wantSandbox: "mybox",
			wantRemote:  "/srv",
			wantLocal:   "./dir",
		},
		// Not streamable — fall back to scp.
		{name: "external scp host is not streamed", argv: []string{"./a", "scp://host/x"}, wantStream: false},
		{name: "local to local is not streamed", argv: []string{"./a", "./b"}, wantStream: false},
		{name: "sandbox to sandbox is not streamed", argv: []string{"a:/x", "b:/y"}, wantStream: false},
		{name: "three operands are not streamed", argv: []string{"./a", "./b", "mybox:/c"}, wantStream: false},
		{name: "single operand is not streamed", argv: []string{"mybox:/c"}, wantStream: false},
		// Malformed sandbox URI surfaces an error.
		{name: "malformed sbox uri errors", argv: []string{"./a", "sbox://bad%zz/x"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sp, ok, err := planStreamTransfer(scpPlan{scpArgv: tt.argv})
			if tt.wantErr {
				if err == nil {
					t.Fatalf("planStreamTransfer(%v) expected error", tt.argv)
				}
				return
			}
			if err != nil {
				t.Fatalf("planStreamTransfer(%v) unexpected error = %v", tt.argv, err)
			}
			if ok != tt.wantStream {
				t.Fatalf("stream = %v, want %v", ok, tt.wantStream)
			}
			if !ok {
				return
			}
			if sp.upload != tt.wantUpload || sp.recursive != tt.wantRecurse ||
				sp.sandboxName != tt.wantSandbox || sp.remotePath != tt.wantRemote || sp.localPath != tt.wantLocal {
				t.Errorf("plan = %+v, want upload=%v recurse=%v sandbox=%q remote=%q local=%q",
					sp, tt.wantUpload, tt.wantRecurse, tt.wantSandbox, tt.wantRemote, tt.wantLocal)
			}
		})
	}
}

func TestSplitOperandsAndFlags(t *testing.T) {
	tests := []struct {
		name         string
		argv         []string
		wantOperands []string
		wantRecurse  bool
	}{
		{name: "no flags", argv: []string{"a", "b"}, wantOperands: []string{"a", "b"}},
		{name: "-r detected", argv: []string{"-r", "a", "b"}, wantOperands: []string{"a", "b"}, wantRecurse: true},
		{name: "bundled -rp", argv: []string{"-rp", "a", "b"}, wantOperands: []string{"a", "b"}, wantRecurse: true},
		{name: "option with arg skipped", argv: []string{"-l", "100", "a", "b"}, wantOperands: []string{"a", "b"}},
		{name: "r inside an identity path is not -r", argv: []string{"-i/home/dir/key", "a", "b"}, wantOperands: []string{"a", "b"}},
		{name: "-- ends options", argv: []string{"--", "-r", "b"}, wantOperands: []string{"-r", "b"}},
		{name: "dash operand after operand", argv: []string{"a", "-r", "b"}, wantOperands: []string{"a", "-r", "b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ops, rec := splitOperandsAndFlags(tt.argv)
			if rec != tt.wantRecurse {
				t.Errorf("recursive = %v, want %v", rec, tt.wantRecurse)
			}
			if len(ops) != len(tt.wantOperands) {
				t.Fatalf("operands = %#v, want %#v", ops, tt.wantOperands)
			}
			for i := range ops {
				if ops[i] != tt.wantOperands[i] {
					t.Fatalf("operands = %#v, want %#v", ops, tt.wantOperands)
				}
			}
		})
	}
}

func TestRemoteCmdBuilders(t *testing.T) {
	if got := uploadFileRemoteCmd("/tmp/f", "f", 13); got != `d='/tmp/f'; if [ -d "$d" ]; then d="$d/"'f'; fi; exec head -c 13 > "$d"` {
		t.Errorf("uploadFileRemoteCmd = %q", got)
	}
	if got := uploadDirRemoteCmd("/srv", 2048); got != `mkdir -p '/srv' && head -c 2048 | tar -x -C '/srv'` {
		t.Errorf("uploadDirRemoteCmd = %q", got)
	}
	if got := downloadFileRemoteCmd("/etc/hosts"); got != `exec cat '/etc/hosts'` {
		t.Errorf("downloadFileRemoteCmd = %q", got)
	}
	if got := downloadDirRemoteCmd("/srv/out"); got != `exec tar -c -C '/srv' 'out'` {
		t.Errorf("downloadDirRemoteCmd = %q", got)
	}
	// A single quote in a path is escaped so it can't break out of the quoting.
	if got := downloadFileRemoteCmd("/tmp/it's"); got != `exec cat '/tmp/it'\''s'` {
		t.Errorf("shell-quote escaping = %q", got)
	}
}
