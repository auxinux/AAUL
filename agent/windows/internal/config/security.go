package config

import (
	"encoding/json"
)

// Security is the local TLS and signing policy. It mirrors security.json as
// written by the Python agent (agent/app/lib/security.py).
type Security struct {
	VerifyTLS       bool `json:"verifyTls"`
	AllowSelfSigned bool `json:"allowSelfSigned"`
	SignRequests    bool `json:"signRequests"`
	// VerifyResponses defaults to SignRequests when the key is absent, which is
	// why it is a pointer: the zero value and "not set" mean different things.
	VerifyResponses *bool `json:"verifyResponses,omitempty"`
}

// DefaultSecurity is the policy used when security.json is missing or invalid.
// It is the strict one on purpose: a damaged file must not silently downgrade
// the connection.
func DefaultSecurity() Security {
	return Security{VerifyTLS: true, AllowSelfSigned: false, SignRequests: true}
}

// LoadSecurity reads security.json, falling back to the strict defaults.
func LoadSecurity() Security {
	data, err := ReadJSONFile(SecurityConfigPath())
	if err != nil {
		return DefaultSecurity()
	}
	security := DefaultSecurity()
	if err := json.Unmarshal(data, &security); err != nil {
		return DefaultSecurity()
	}
	return security
}

// ShouldVerifyResponses reports whether dashboard responses must be signed.
func (s Security) ShouldVerifyResponses() bool {
	if s.VerifyResponses != nil {
		return *s.VerifyResponses
	}
	return s.SignRequests
}

// Save writes security.json atomically.
func (s Security) Save() error {
	payload, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return WriteFileAtomic(SecurityConfigPath(), payload)
}
