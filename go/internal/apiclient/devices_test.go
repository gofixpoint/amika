package apiclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRegisterDevicePostsTheEndpointID(t *testing.T) {
	endpointID := strings.Repeat("ab", 32)
	var body map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v0beta1/devices" {
			t.Errorf("request = %s %s", r.Method, r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode: %v", err)
		}
		_, _ = w.Write([]byte(`{"device_id":"dev_01"}`))
	}))
	defer server.Close()

	device, err := NewClient(server.URL, "api-token").RegisterDevice(RegisterDeviceRequest{
		EndpointID: endpointID,
		Name:       "laptop",
		Platform:   "darwin",
	})
	if err != nil || device.DeviceID != "dev_01" {
		t.Fatalf("RegisterDevice = %+v, %v", device, err)
	}
	want := map[string]any{"endpoint_id": endpointID, "name": "laptop", "platform": "darwin"}
	if len(body) != len(want) {
		t.Fatalf("body = %v", body)
	}
	for field, value := range want {
		if body[field] != value {
			t.Fatalf("body[%s] = %v, want %v", field, body[field], value)
		}
	}
}

func TestRegisterDeviceRefusesAnAnswerWithNoDeviceID(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	if _, err := NewClient(server.URL, "api-token").RegisterDevice(RegisterDeviceRequest{}); err == nil {
		t.Fatal("RegisterDevice accepted an answer with no device_id")
	}
}
