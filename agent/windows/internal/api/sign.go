// Package api is the agent's HTTP client for the dashboard.
//
// Everything about the wire format is dictated by the dashboard and must match
// the Python agent byte for byte:
//
//   - requests carry `Authorization: Bearer <token>`;
//   - mutating requests are signed with HMAC-SHA256 over
//     "<timestamp>.<nonce>.<body>" and carry X-Signature / X-Timestamp / X-Nonce
//     (dashboard/server/middleware/auth.js:79);
//   - responses are signed the same way over
//     "<X-Response-Timestamp>.<X-Response-Nonce>.<body>".
//
// The server verifies the signature against the raw bytes it received before
// falling back to re-canonicalising the parsed body, so the rule here is
// simple: serialise once, sign those exact bytes, send those exact bytes.
package api

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"time"
)

// Marshal encodes a payload the way the agent puts it on the wire.
//
// encoding/json escapes <, > and & into \u003c, \u003e and \u0026 by default, which
// Python's json.dumps does not. That difference would not break the signature
// (the server hashes the raw bytes) but it would produce needlessly mangled
// values in the dashboard, so HTML escaping is turned off.
func Marshal(payload any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		return nil, err
	}
	// Encode appends a newline; drop it so the body matches what the Python
	// agent sends for the same payload.
	return bytes.TrimRight(buffer.Bytes(), "\n"), nil
}

// Signature is the triplet of headers proving a request came from this agent.
type Signature struct {
	Signature string
	Timestamp string
	Nonce     string
}

func newNonce() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// ComputeHMAC returns the lowercase hex HMAC-SHA256 of message under secret.
func ComputeHMAC(message, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(message))
	return hex.EncodeToString(mac.Sum(nil))
}

// SignBody signs the exact bytes that will be sent.
func SignBody(body []byte, secret string) (Signature, error) {
	nonce, err := newNonce()
	if err != nil {
		return Signature{}, err
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	return signBodyWith(body, secret, timestamp, nonce), nil
}

// signBodyWith is the deterministic core, split out so tests can pin the
// timestamp and nonce and compare against vectors produced by the Python agent.
func signBodyWith(body []byte, secret, timestamp, nonce string) Signature {
	message := fmt.Sprintf("%s.%s.%s", timestamp, nonce, string(body))
	return Signature{
		Signature: ComputeHMAC(message, secret),
		Timestamp: timestamp,
		Nonce:     nonce,
	}
}

// responseMaxAge matches the window the Python agent enforces on signed
// dashboard responses.
const responseMaxAge = 300 * time.Second

// verifyResponseSignature checks the signature the dashboard put on its reply.
// It is what stops a network attacker from feeding the agent forged commands
// even if TLS verification has been relaxed.
func verifyResponseSignature(headers responseHeaders, body []byte, secret string) error {
	if headers.signature == "" || headers.timestamp == "" || headers.nonce == "" {
		return fmt.Errorf("missing response signature")
	}
	seconds, err := strconv.ParseInt(headers.timestamp, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid response signature timestamp")
	}
	age := time.Since(time.Unix(seconds, 0))
	if age < 0 {
		age = -age
	}
	if age > responseMaxAge {
		return fmt.Errorf("expired response signature")
	}

	message := fmt.Sprintf("%s.%s.%s", headers.timestamp, headers.nonce, string(body))
	expected := ComputeHMAC(message, secret)
	if !hmac.Equal([]byte(expected), []byte(headers.signature)) {
		return fmt.Errorf("invalid response signature")
	}
	return nil
}

type responseHeaders struct {
	signature string
	timestamp string
	nonce     string
}
