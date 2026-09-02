package api

import (
	"encoding/json"
	"strings"
	"testing"
)

// Vectors produced by the Python agent's sign_request()
// (agent/app/lib/security.py) with a pinned timestamp and nonce. They pin the
// message construction "<timestamp>.<nonce>.<body>" and the HMAC itself, which
// is what the dashboard verifies in
// dashboard/server/middleware/auth.js:verifyAgentSignature.
func TestSignBodyMatchesPythonAgent(t *testing.T) {
	const (
		timestamp = "1756800000"
		nonce     = "0123456789abcdef0123456789abcdef"
	)
	cases := []struct {
		name, body, secret, want string
	}{
		{
			name:   "simple",
			body:   `{"agentId":"abc-123","hostname":"WIN-PC"}`,
			secret: "s3cr3t",
			want:   "596027148584f49eca708f57c1d2974d4957ebcef95570dbef3eef3f6750fedb",
		},
		{
			name:   "non-ascii secret and body",
			body:   `{"displayName":"Poste R\u00e9ception","note":"caf\u00e9"}`,
			secret: "clé-très-secrète",
			want:   "6fee624cc58088cdca9afd2d446f1b0ab833d21099ad23f8a7ab4743baa8cf71",
		},
		{
			name:   "html-significant characters",
			body:   `{"cmd":"a < b && c > d","path":"C:\\Program Files\\x"}`,
			secret: "tok",
			want:   "58ec51c69222a0d348b94454c8b56a8b5553a0f87e77878973507239abb42ce3",
		},
		{
			name:   "nested payload with null and float",
			body:   `{"list":[1,2,3],"logStats":null,"metrics":{"cpuPercent":12.5,"memory":{"totalBytes":8589934592}}}`,
			secret: "another-token",
			want:   "c4862ec92404ae4d67d4b411ff4701cae901614c5f1baf06def46c400edb8eaf",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := signBodyWith([]byte(testCase.body), testCase.secret, timestamp, nonce)
			if got.Signature != testCase.want {
				t.Errorf("signature mismatch\n got: %s\nwant: %s", got.Signature, testCase.want)
			}
			if got.Timestamp != timestamp || got.Nonce != nonce {
				t.Errorf("headers not echoed back: %+v", got)
			}
		})
	}
}

// The dashboard hashes the raw request body, so the only hard requirement on
// Marshal is that the bytes we sign are the bytes we send. This guards the one
// way Go silently rewrites them.
func TestMarshalDoesNotHTMLEscape(t *testing.T) {
	body, err := Marshal(map[string]string{"cmd": "a < b && c > d"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), `\u003c`) {
		t.Errorf("HTML escaping is still on: %s", body)
	}
	if strings.HasSuffix(string(body), "\n") {
		t.Errorf("trailing newline was not trimmed: %q", body)
	}
	var round map[string]string
	if err := json.Unmarshal(body, &round); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	if round["cmd"] != "a < b && c > d" {
		t.Errorf("value did not survive the round trip: %q", round["cmd"])
	}
}

func TestSignBodyGeneratesFreshNonces(t *testing.T) {
	first, err := SignBody([]byte(`{}`), "secret")
	if err != nil {
		t.Fatal(err)
	}
	second, err := SignBody([]byte(`{}`), "secret")
	if err != nil {
		t.Fatal(err)
	}
	// A repeated nonce would be rejected as a replay by the dashboard.
	if first.Nonce == second.Nonce {
		t.Error("nonce was reused between two signatures")
	}
	if len(first.Nonce) != 32 {
		t.Errorf("nonce should be 16 bytes hex-encoded, got %d chars", len(first.Nonce))
	}
}

func TestVerifyResponseSignature(t *testing.T) {
	const secret = "token"
	body := []byte(`{"ok":true,"command":null}`)
	signed := signBodyWith(body, secret, nowUnixString(), "abcdef")

	headers := responseHeaders{signature: signed.Signature, timestamp: signed.Timestamp, nonce: "abcdef"}
	if err := verifyResponseSignature(headers, body, secret); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}

	// A tampered body must not validate: this is what stops a forged command
	// from reaching the agent when TLS verification has been relaxed.
	if err := verifyResponseSignature(headers, []byte(`{"ok":true,"command":{"type":"UNINSTALL"}}`), secret); err == nil {
		t.Error("tampered body was accepted")
	}
	if err := verifyResponseSignature(headers, body, "wrong-token"); err == nil {
		t.Error("signature from the wrong key was accepted")
	}

	stale := responseHeaders{signature: signed.Signature, timestamp: "1000000000", nonce: "abcdef"}
	if err := verifyResponseSignature(stale, body, secret); err == nil {
		t.Error("expired signature was accepted")
	}
	if err := verifyResponseSignature(responseHeaders{}, body, secret); err == nil {
		t.Error("missing signature headers were accepted")
	}
}

func nowUnixString() string {
	signature, err := SignBody(nil, "x")
	if err != nil {
		panic(err)
	}
	return signature.Timestamp
}
