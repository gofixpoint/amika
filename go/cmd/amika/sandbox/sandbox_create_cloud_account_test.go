package sandboxcmd

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/spf13/cobra"

	"github.com/gofixpoint/amika/go/internal/apiclient"
	"github.com/gofixpoint/amika/go/internal/gitrepo"
)

func TestCreateCloudAccount(t *testing.T) {
	newCmd := func() *cobra.Command {
		c := &cobra.Command{}
		c.Flags().String("cloud-account", "", "")
		return c
	}

	if sel, err := createCloudAccount(newCmd()); err != nil || sel != (apiclient.CloudAccountSelector{}) {
		t.Errorf("absent flag: got %+v, %v", sel, err)
	}
	for raw, want := range map[string]apiclient.CloudAccountSelector{
		"prod":        {Value: "prod", By: apiclient.SelectByRef},
		"name=prod":   {Value: "prod", By: apiclient.SelectByName},
		"id=cacc_1":   {Value: "cacc_1", By: apiclient.SelectByID},
		"amika":       {Value: "amika", By: apiclient.SelectByRef},
		"ref=id=odd":  {Value: "id=odd", By: apiclient.SelectByRef},
		"_self":       {Value: "_self", By: apiclient.SelectByRef},
		"name=_self":  {Value: "_self", By: apiclient.SelectByName},
		"cacc_1-name": {Value: "cacc_1-name", By: apiclient.SelectByRef},
	} {
		c := newCmd()
		c.Flags().Set("cloud-account", raw)
		if sel, err := createCloudAccount(c); err != nil || sel != want {
			t.Errorf("%q: got %+v, %v; want %+v", raw, sel, err, want)
		}
	}
	// An unset "$ACCOUNT" must not quietly land the rig in the default account.
	for _, raw := range []string{"", "  ", "id="} {
		c := newCmd()
		c.Flags().Set("cloud-account", raw)
		if _, err := createCloudAccount(c); err == nil {
			t.Errorf("%q: want an error", raw)
		}
	}
}

func TestCreateHostRefRefusesACloudAccount(t *testing.T) {
	c := &cobra.Command{}
	for _, name := range []string{"host", "provider", "cloud-account"} {
		c.Flags().String(name, "", "")
	}
	c.Flags().Set("host", "alpha.lan")
	c.Flags().Set("cloud-account", "prod")
	_, err := createHostRef(c)
	if err == nil || !strings.Contains(err.Error(), "--cloud-account cannot be combined with --host") {
		t.Errorf("err = %v", err)
	}
}

func TestSetCloudAccountUsesTheFieldOfTheKind(t *testing.T) {
	for _, tt := range []struct {
		sel  apiclient.CloudAccountSelector
		want string
	}{
		{apiclient.CloudAccountSelector{}, `{}`},
		{apiclient.CloudAccountSelector{Value: "prod"}, `{"cloud_account_ref":"prod"}`},
		{apiclient.CloudAccountSelector{Value: "prod", By: apiclient.SelectByName, Provider: "e2b"}, `{"cloud_account_name":"prod"}`},
		{apiclient.CloudAccountSelector{Value: "cacc_1", By: apiclient.SelectByID}, `{"cloud_account_id":"cacc_1"}`},
	} {
		var req apiclient.CreateSandboxRequest
		req.SetCloudAccount(tt.sel)
		got, _ := json.Marshal(req)
		if string(got) != tt.want {
			t.Errorf("%+v: body = %s, want %s", tt.sel, got, tt.want)
		}
	}
}

func TestAssertRigLandedInCloudAccount(t *testing.T) {
	ref := func(s string) *string { return &s }
	prod := &apiclient.RemoteSandboxCloudAccount{ID: "cacc_1", Name: "prod"}
	tests := []struct {
		name    string
		sb      apiclient.RemoteSandbox
		sel     apiclient.CloudAccountSelector
		wantErr string
	}{
		{name: "no account asked for", sb: apiclient.RemoteSandbox{Name: "dev"}},
		{name: "by ref, matched by name", sb: apiclient.RemoteSandbox{Name: "dev", CloudAccount: prod}, sel: apiclient.CloudAccountSelector{Value: "prod"}},
		{name: "by ref, matched by id", sb: apiclient.RemoteSandbox{Name: "dev", CloudAccount: prod}, sel: apiclient.CloudAccountSelector{Value: "cacc_1"}},
		{name: "by id", sb: apiclient.RemoteSandbox{Name: "dev", CloudAccount: prod}, sel: apiclient.CloudAccountSelector{Value: "cacc_1", By: apiclient.SelectByID}},
		{name: "amika is Amika Cloud", sb: apiclient.RemoteSandbox{Name: "dev", Provider: ref("e2b")}, sel: apiclient.CloudAccountSelector{Value: "amika"}},
		{
			name:    "field dropped by the control plane",
			sb:      apiclient.RemoteSandbox{Name: "dev", Provider: ref("instabox")},
			sel:     apiclient.CloudAccountSelector{Value: "prod"},
			wantErr: "Amika Cloud (provider instabox). It is most likely a version that does not support --cloud-account",
		},
		{
			name:    "by name, but the id matched",
			sb:      apiclient.RemoteSandbox{Name: "dev", Provider: ref("instabox"), CloudAccount: prod},
			sel:     apiclient.CloudAccountSelector{Value: "cacc_1", By: apiclient.SelectByName},
			wantErr: "cloud account instabox/prod (cacc_1). That is not the account",
		},
		{
			name:    "amika asked for, landed in an account",
			sb:      apiclient.RemoteSandbox{Name: "dev", Provider: ref("instabox"), CloudAccount: prod},
			sel:     apiclient.CloudAccountSelector{Value: "amika", By: apiclient.SelectByName},
			wantErr: "instabox/prod",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := assertRigLandedInCloudAccount(&tt.sb, tt.sel)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) || !strings.Contains(err.Error(), "amika rig delete dev") {
				t.Errorf("err = %v, want %q and the cleanup command in it", err, tt.wantErr)
			}
		})
	}
}

func TestRigCloud(t *testing.T) {
	ref := func(s string) *string { return &s }
	prod := &apiclient.RemoteSandboxCloudAccount{ID: "cacc_1", Name: "prod"}
	for _, tt := range []struct {
		sb   apiclient.RemoteSandbox
		want string
	}{
		{apiclient.RemoteSandbox{Provider: ref("e2b")}, "e2b/amika"},
		{apiclient.RemoteSandbox{Provider: ref("instabox"), CloudAccount: prod}, "instabox/prod"},
		{apiclient.RemoteSandbox{Provider: ref("e2b"), HostID: ref("host_1")}, ""},
		{apiclient.RemoteSandbox{}, ""},
	} {
		if got := rigCloud(tt.sb); got != tt.want {
			t.Errorf("rigCloud(%+v) = %q, want %q", tt.sb, got, tt.want)
		}
	}
}

// stubCloudAccountCreateAPI serves a create and its poll. honor false models
// a control plane that predates cloud accounts: it strips the field and
// builds the rig on Amika Cloud. It records the create body.
func stubCloudAccountCreateAPI(t *testing.T, honor bool) *map[string]any {
	t.Helper()
	var createBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "POST" && r.URL.Path == "/api/v0beta1/sandboxes":
			json.NewDecoder(r.Body).Decode(&createBody)
			io.WriteString(w, `{"name":"dev","state":"initializing"}`)
		case honor:
			io.WriteString(w, `{"name":"dev","state":"active","provider":"instabox","cloud_account":{"id":"cacc_1","name":"prod"}}`)
		default:
			io.WriteString(w, `{"name":"dev","state":"active","provider":"instabox"}`)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("AMIKA_API_URL", srv.URL)
	t.Setenv("AMIKA_API_KEY", "test-token")
	return &createBody
}

func TestCreateRemoteSandboxSendsTheCloudAccount(t *testing.T) {
	body := stubCloudAccountCreateAPI(t, true)
	c, out := newCreateCmd(t)
	c.Flags().Set("provider", "instabox")
	c.Flags().Set("cloud-account", "prod")

	if err := createRemoteSandbox(c, "", "dev", gitrepo.Identity{Source: gitrepo.SourceNone}); err != nil {
		t.Fatalf("createRemoteSandbox: %v", err)
	}
	if (*body)["provider"] != "instabox" || (*body)["cloud_account_ref"] != "prod" {
		t.Errorf("body = %v, want provider instabox and cloud_account_ref prod", *body)
	}
	for _, other := range []string{"cloud_account_name", "cloud_account_id", "host_id"} {
		if _, ok := (*body)[other]; ok {
			t.Errorf("body carries %q: %v", other, *body)
		}
	}
	if !strings.Contains(out.String(), `Rig "dev" created in instabox/prod`) {
		t.Errorf("output = %q", out.String())
	}
}

func TestCreateRemoteSandboxFailsWhenTheCloudAccountWasIgnored(t *testing.T) {
	stubCloudAccountCreateAPI(t, false)
	c, _ := newCreateCmd(t)
	c.Flags().Set("cloud-account", "id=cacc_1")

	err := createRemoteSandbox(c, "", "dev", gitrepo.Identity{Source: gitrepo.SourceNone})
	if err == nil {
		t.Fatal("want an error for a rig that did not land in the account")
	}
	for _, want := range []string{"not in the cloud account you asked for", "Amika Cloud", "amika rig delete dev"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("err = %v, want %q in it", err, want)
		}
	}
}

// `rig get` prints every response field, so the account shows up with no
// code of its own; this pins the keys a reader looks for.
func TestWriteSandboxGetTextShowsTheCloudAccount(t *testing.T) {
	provider := "instabox"
	for _, tt := range []struct {
		account *apiclient.RemoteSandboxCloudAccount
		want    []string
	}{
		{&apiclient.RemoteSandboxCloudAccount{ID: "cacc_1", Name: "prod"}, []string{"cloud_account.id: cacc_1\n", "cloud_account.name: prod\n"}},
		{nil, []string{"cloud_account: -\n"}},
	} {
		var out strings.Builder
		if err := writeSandboxGetText(&out, sandboxGetResult{RemoteSandbox: apiclient.RemoteSandbox{
			ID: "sb_1", Name: "box", Provider: &provider, CloudAccount: tt.account,
		}}); err != nil {
			t.Fatal(err)
		}
		for _, want := range tt.want {
			if !strings.Contains(out.String(), want) {
				t.Errorf("text output missing %q:\n%s", want, out.String())
			}
		}
	}
}
