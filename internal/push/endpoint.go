package push

import (
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// A Web Push endpoint is a URL the browser hands us and we later POST to.
// Left unvalidated it is a server-side request forgery primitive: any
// authenticated user can register http://169.254.169.254/…, or the address
// of a service on our own Docker network (QuestDB's REST API, Redis,
// Postgres), and have the server issue requests to it on their behalf. The
// response never reaches them, but a blind POST into the internal network
// is plenty.
//
// The load-bearing control is the host allowlist below. Endpoints are
// issued by a small, well-known set of push services — anything else is
// not a real subscription, whatever it resolves to. That property is what
// makes this robust against DNS rebinding: a name only passes if it ends
// in a push-service suffix, and we do not control what those resolve to
// anyway. The scheme and address-literal checks are a second layer for
// hosts an operator adds via WEBPUSH_ALLOWED_HOSTS.

// defaultAllowedHosts are the push services browsers actually issue
// endpoints for:
//
//	fcm.googleapis.com            Chrome, Chromium, Edge, Opera, Samsung
//	android.googleapis.com        legacy GCM endpoints still in the wild
//	*.push.services.mozilla.com   Firefox (autopush nodes vary by region)
//	*.push.apple.com              Safari 16.4+ on macOS and iOS
//	*.notify.windows.com          legacy EdgeHTML
//
// A leading dot means "this domain or any subdomain"; an entry without one
// must match the host exactly. Deliberately not a bare "googleapis.com" —
// that would also admit storage.googleapis.com and every other Google API.
var defaultAllowedHosts = []string{
	"fcm.googleapis.com",
	"android.googleapis.com",
	".push.services.mozilla.com",
	".push.apple.com",
	".notify.windows.com",
}

// maxEndpointLen bounds the stored URL. Real endpoints run ~200 chars;
// this only stops an unbounded string reaching the database.
const maxEndpointLen = 1024

// Key sizes fixed by RFC 8291 / RFC 8292: p256dh is an uncompressed P-256
// point (65 bytes), auth is a 16-byte secret. Checking them here keeps
// malformed input from reaching the encryption layer as a runtime error
// on a background goroutine, where nobody is watching.
const (
	p256dhLen = 65
	authLen   = 16
)

// EndpointValidator checks push endpoints against an allowlist of hosts.
// The zero value is not usable — construct one with NewEndpointValidator.
type EndpointValidator struct {
	allowed []string
}

// NewEndpointValidator returns a validator for the given host suffixes.
// Passing none uses defaultAllowedHosts. Entries are lower-cased; a
// leading dot marks a suffix match, anything else is matched exactly.
func NewEndpointValidator(hosts ...string) *EndpointValidator {
	if len(hosts) == 0 {
		hosts = defaultAllowedHosts
	}
	norm := make([]string, 0, len(hosts))
	for _, h := range hosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			norm = append(norm, h)
		}
	}
	return &EndpointValidator{allowed: norm}
}

// AllowedHosts returns the configured suffixes, for logging at startup.
func (v *EndpointValidator) AllowedHosts() []string { return v.allowed }

// ValidateEndpoint reports whether raw is a push endpoint we are willing
// to send to. The error is safe to return to the caller — it names the
// rule that failed but not the internal topology behind it.
func (v *EndpointValidator) ValidateEndpoint(raw string) error {
	if raw == "" {
		return fmt.Errorf("endpoint is required")
	}
	if len(raw) > maxEndpointLen {
		return fmt.Errorf("endpoint exceeds %d characters", maxEndpointLen)
	}

	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("endpoint is not a valid URL")
	}
	// Plaintext would expose the encrypted payload's routing metadata and,
	// more to the point, is what an internal-service target would need.
	if u.Scheme != "https" {
		return fmt.Errorf("endpoint must use https")
	}
	// Credentials in the URL are never present on a real endpoint and are
	// a classic way to confuse host parsing.
	if u.User != nil {
		return fmt.Errorf("endpoint must not contain credentials")
	}

	host := strings.ToLower(u.Hostname())
	if host == "" {
		return fmt.Errorf("endpoint has no host")
	}
	// Reject address literals outright. No push service is addressed by
	// IP, and this closes the direct-to-metadata-service case even if the
	// allowlist is later widened to something permissive.
	if ip := net.ParseIP(host); ip != nil {
		return fmt.Errorf("endpoint must be a hostname, not an IP address")
	}
	if !v.hostAllowed(host) {
		return fmt.Errorf("endpoint host %q is not a recognised push service", host)
	}
	return nil
}

// hostAllowed matches host against the configured list. A "." prefix on an
// entry means the host may be that domain or any subdomain of it.
func (v *EndpointValidator) hostAllowed(host string) bool {
	for _, a := range v.allowed {
		if strings.HasPrefix(a, ".") {
			// ".push.apple.com" admits web.push.apple.com and
			// push.apple.com, but not evilpush.apple.com.attacker.tld.
			if strings.HasSuffix(host, a) || host == a[1:] {
				return true
			}
			continue
		}
		if host == a {
			return true
		}
	}
	return false
}

// ValidateKeys checks the subscription's crypto material decodes to the
// sizes RFC 8291 fixes. Web Push keys are base64url without padding, but
// some clients send padded values, so both are accepted.
func ValidateKeys(p256dh, auth string) error {
	if n, err := decodedLen(p256dh); err != nil {
		return fmt.Errorf("p256dh is not valid base64url")
	} else if n != p256dhLen {
		return fmt.Errorf("p256dh must decode to %d bytes, got %d", p256dhLen, n)
	}
	if n, err := decodedLen(auth); err != nil {
		return fmt.Errorf("auth is not valid base64url")
	} else if n != authLen {
		return fmt.Errorf("auth must decode to %d bytes, got %d", authLen, n)
	}
	return nil
}

func decodedLen(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("empty")
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return len(b), nil
	}
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		return 0, err
	}
	return len(b), nil
}

// b64RawURL is the encoder counterpart to decodedLen, used by tests to
// build keys of an exact decoded length.
func b64RawURL(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
