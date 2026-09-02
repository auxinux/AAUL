package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"aaul-agent/internal/config"
)

// UserAgent is what the Python agent sends; keeping it makes dashboard access
// logs comparable across the two implementations.
const UserAgent = "AgentAutoUpdate/1.0"

// DefaultTimeout applies to poll and command-result calls. Downloads pass their
// own, longer, timeout.
const DefaultTimeout = 10 * time.Second

// Client talks to one dashboard on behalf of one agent.
type Client struct {
	cfg      *config.Config
	security config.Security
	http     *http.Client
}

// New builds a client from the on-disk configuration and security policy.
func New(cfg *config.Config) *Client {
	security := config.LoadSecurity()
	return &Client{
		cfg:      cfg,
		security: security,
		http: &http.Client{
			Transport: newTransport(security),
			Timeout:   DefaultTimeout,
		},
	}
}

func newTransport(security config.Security) *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// allowSelfSigned keeps the connection encrypted but stops validating the
	// certificate. It exists for lab deployments behind a self-signed cert and
	// is off unless the operator explicitly turned it on in security.json.
	skipVerify := !security.VerifyTLS || security.AllowSelfSigned
	transport.TLSClientConfig = &tls.Config{
		MinVersion:         tls.VersionTLS12,
		InsecureSkipVerify: skipVerify,
	}
	return transport
}

func (c *Client) url(path string) string {
	return strings.TrimRight(c.cfg.DashboardURL, "/") + path
}

// HTTPError carries the status code so callers can tell "the dashboard said no"
// apart from "the dashboard was unreachable".
type HTTPError struct {
	StatusCode int
	Body       string
}

func (e *HTTPError) Error() string {
	return fmt.Sprintf("HTTP %d: %s", e.StatusCode, e.Body)
}

// Post sends a signed JSON request and decodes the (verified) JSON reply into
// out. Pass a nil out to discard the body.
//
// There is deliberately no automatic retry here. A signed request carries a
// one-shot nonce, so a retry has to be re-signed, and both endpoints the agent
// posts to are naturally retried by the poll loop a few seconds later. Silently
// re-sending is not worth the replay-window surface.
func (c *Client) Post(path string, payload any, out any, extraHeaders map[string]string) error {
	body, err := Marshal(payload)
	if err != nil {
		return err
	}

	request, err := http.NewRequest(http.MethodPost, c.url(path), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+c.cfg.AgentAPIToken)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", UserAgent)
	for key, value := range extraHeaders {
		request.Header.Set(key, value)
	}

	if c.security.SignRequests {
		signature, err := SignBody(body, c.cfg.AgentAPIToken)
		if err != nil {
			return err
		}
		request.Header.Set("X-Signature", signature.Signature)
		request.Header.Set("X-Timestamp", signature.Timestamp)
		request.Header.Set("X-Nonce", signature.Nonce)
	}

	response, err := c.http.Do(request)
	if err != nil {
		return fmt.Errorf("request to %s failed: %w", path, err)
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return fmt.Errorf("reading response from %s failed: %w", path, err)
	}

	if response.StatusCode >= 400 {
		return &HTTPError{StatusCode: response.StatusCode, Body: string(responseBody)}
	}

	if c.security.ShouldVerifyResponses() {
		headers := responseHeaders{
			signature: strings.TrimSpace(response.Header.Get("X-Response-Signature")),
			timestamp: strings.TrimSpace(response.Header.Get("X-Response-Timestamp")),
			nonce:     strings.TrimSpace(response.Header.Get("X-Response-Nonce")),
		}
		if err := verifyResponseSignature(headers, responseBody, c.cfg.AgentAPIToken); err != nil {
			return err
		}
	}

	if out == nil {
		return nil
	}
	if err := json.Unmarshal(responseBody, out); err != nil {
		return fmt.Errorf("invalid JSON from %s: %w", path, err)
	}
	return nil
}

// Get performs an authenticated GET and hands the live response to the caller,
// which is responsible for closing the body. Used for binary downloads, where
// buffering the whole payload in memory first would be wasteful.
//
// GET requests are not signed — matching the Python agent and the dashboard,
// which only requires signatures on mutating endpoints. Download integrity is
// covered separately by the bundle SHA-256 and its HMAC.
func (c *Client) Get(path string, timeout time.Duration) (*http.Response, error) {
	request, err := http.NewRequest(http.MethodGet, c.url(path), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+c.cfg.AgentAPIToken)
	request.Header.Set("User-Agent", UserAgent)

	client := &http.Client{Transport: c.http.Transport, Timeout: timeout}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request to %s failed: %w", path, err)
	}
	if response.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 8192))
		response.Body.Close()
		return nil, &HTTPError{StatusCode: response.StatusCode, Body: string(body)}
	}
	return response, nil
}

// Token exposes the agent API token, which doubles as the HMAC key used to
// verify anything the dashboard signs for this agent specifically.
func (c *Client) Token() string {
	return c.cfg.AgentAPIToken
}

// Config returns the configuration this client was built from.
func (c *Client) Config() *config.Config {
	return c.cfg
}
