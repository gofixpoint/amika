package apiclient

import (
	"encoding/json"
	"testing"
)

func TestCloudAccountRequestPaths(t *testing.T) {
	isDefault := false
	tests := []struct {
		name       string
		call       func(c *Client) error
		wantMethod string
		wantURI    string
		wantBody   string
	}{
		{"ListCloudAccounts", func(c *Client) error { _, err := c.ListCloudAccounts(""); return err }, "GET", "/api/v0beta1/cloud-accounts", ""},
		{"ListCloudAccounts by provider", func(c *Client) error { _, err := c.ListCloudAccounts("instabox"); return err }, "GET", "/api/v0beta1/cloud-accounts?provider=instabox", ""},
		{"GetCloudAccount by ref", func(c *Client) error {
			_, err := c.GetCloudAccount(CloudAccountSelector{Value: "prod"})
			return err
		}, "GET", "/api/v0beta1/cloud-accounts/prod", ""},
		{"GetCloudAccount by id", func(c *Client) error {
			_, err := c.GetCloudAccount(CloudAccountSelector{Value: "cacc_1", By: SelectByID})
			return err
		}, "GET", "/api/v0beta1/cloud-accounts/cacc_1?by=id", ""},
		{"UpdateCloudAccount by name and provider", func(c *Client) error {
			_, err := c.UpdateCloudAccount(CloudAccountSelector{Value: "prod", By: SelectByName, Provider: "e2b"}, UpdateCloudAccountRequest{IsDefault: &isDefault})
			return err
		}, "PATCH", "/api/v0beta1/cloud-accounts/prod?by=name&provider=e2b", `{"is_default":false}`},
		{"DeleteCloudAccount by ref and provider", func(c *Client) error {
			return c.DeleteCloudAccount(CloudAccountSelector{Value: "prod", Provider: "e2b"})
		}, "DELETE", "/api/v0beta1/cloud-accounts/prod?provider=e2b", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, requests := jobServer(t, `{}`)
			if err := tt.call(c); err != nil {
				t.Fatal(err)
			}
			got := (*requests)[0]
			if got.method != tt.wantMethod || got.uri != tt.wantURI || got.body != tt.wantBody {
				t.Errorf("got %s %s %s, want %s %s %s", got.method, got.uri, got.body, tt.wantMethod, tt.wantURI, tt.wantBody)
			}
		})
	}
}

func TestCreateCloudAccountSendsTheKeyAndDecodesTheAccount(t *testing.T) {
	c, requests := jobServer(t, `{"id":"cacc_1","provider":"instabox","name":"prod","is_default":true,"created_at":"t0","updated_at":"t1"}`)
	isDefault := true
	account, err := c.CreateCloudAccount(CreateCloudAccountRequest{Provider: "instabox", Name: "prod", APIKey: "k", IsDefault: &isDefault})
	if err != nil {
		t.Fatal(err)
	}
	got := (*requests)[0]
	if got.method != "POST" || got.uri != "/api/v0beta1/cloud-accounts" {
		t.Errorf("got %s %s", got.method, got.uri)
	}
	if want := `{"provider":"instabox","name":"prod","api_key":"k","is_default":true}`; got.body != want {
		t.Errorf("body = %s, want %s", got.body, want)
	}
	want := CloudAccount{ID: "cacc_1", Provider: "instabox", Name: "prod", IsDefault: true, CreatedAt: "t0", UpdatedAt: "t1"}
	if *account != want {
		t.Errorf("account = %+v, want %+v", *account, want)
	}
}

func TestListCloudAccountsEmitsAnEmptyArray(t *testing.T) {
	c, _ := jobServer(t, `{"items":null}`)
	list, err := c.ListCloudAccounts("")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(list)
	if string(encoded) != `{"items":[]}` {
		t.Errorf("encoded = %s", encoded)
	}
}
