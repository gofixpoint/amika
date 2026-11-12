package apiclient

import "fmt"

// RegisterDeviceRequest registers this machine's amika-net device key.
type RegisterDeviceRequest struct {
	// EndpointID is the device's Ed25519 public key in lowercase hex.
	EndpointID string `json:"endpoint_id"`
	Name       string `json:"name"`
	Platform   string `json:"platform"`
}

// Device is the control plane's answer to a registration.
type Device struct {
	DeviceID string `json:"device_id"`
}

// RegisterDevice registers an amika-net device key for the caller. The same
// endpoint id for the same user returns the same device, so a repeat is
// safe.
func (c *Client) RegisterDevice(request RegisterDeviceRequest) (*Device, error) {
	var result Device
	if err := c.doJSON("POST", apiBasePath+"/devices", request, &result); err != nil {
		return nil, fmt.Errorf("remote register device: %w", err)
	}
	if result.DeviceID == "" {
		return nil, fmt.Errorf("remote register device: the answer has no device_id")
	}
	return &result, nil
}
