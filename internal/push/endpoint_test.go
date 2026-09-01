package push

import "testing"

func TestValidateEndpoint_RejectsSSRFTargets(t *testing.T) {
	v := NewEndpointValidator()
	// Every one of these was accepted before the allowlist existed, stored
	// verbatim, and handed to webpush.SendNotificationWithContext.
	cases := []struct {
		name, endpoint string
	}{
		{"cloud metadata service", "http://169.254.169.254/latest/meta-data/"},
		{"metadata over https", "https://169.254.169.254/latest/meta-data/"},
		{"questdb rest on the compose network", "http://questdb:9000/exec?query=DROP+TABLE+equities"},
		{"loopback", "http://127.0.0.1:8080/admin"},
		{"localhost by name", "https://localhost/"},
		{"private range", "http://10.0.0.5/"},
		{"ipv6 loopback", "https://[::1]/"},
		{"plaintext scheme", "http://fcm.googleapis.com/fcm/send/abc"},
		{"credentials in url", "https://user:pass@fcm.googleapis.com/fcm/send/abc"},
		{"suffix confusion", "https://fcm.googleapis.com.attacker.tld/fcm/send/abc"},
		{"subdomain confusion", "https://evilpush.apple.com.attacker.tld/x"},
		{"file scheme", "file:///etc/passwd"},
		{"empty", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := v.ValidateEndpoint(tc.endpoint); err == nil {
				t.Errorf("ValidateEndpoint(%q) = nil, want rejection", tc.endpoint)
			}
		})
	}
}

func TestValidateEndpoint_AcceptsRealPushServices(t *testing.T) {
	v := NewEndpointValidator()
	cases := []struct {
		name, endpoint string
	}{
		{"chrome", "https://fcm.googleapis.com/fcm/send/ePnU4vJ9zJk:APA91bH..."},
		{"legacy gcm", "https://android.googleapis.com/gcm/send/abc123"},
		{"firefox", "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA"},
		{"firefox autopush node", "https://autopush.push.services.mozilla.com/wpush/v2/x"},
		{"safari", "https://web.push.apple.com/QMHc2v0d..."},
		{"legacy edge", "https://hk2.notify.windows.com/w/?token=abc"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := v.ValidateEndpoint(tc.endpoint); err != nil {
				t.Errorf("ValidateEndpoint(%q) = %v, want accepted", tc.endpoint, err)
			}
		})
	}
}

func TestValidateEndpoint_HonoursConfiguredHosts(t *testing.T) {
	v := NewEndpointValidator("push.example.test")
	if err := v.ValidateEndpoint("https://push.example.test/send/1"); err != nil {
		t.Errorf("configured host rejected: %v", err)
	}
	// Widening the list must not re-open the default services implicitly,
	// nor admit an address literal.
	if err := v.ValidateEndpoint("https://192.0.2.1/send/1"); err == nil {
		t.Error("IP literal accepted under a custom allowlist")
	}
}

func TestValidateKeys(t *testing.T) {
	// 65-byte P-256 point and 16-byte auth secret, base64url.
	p256dh := "BEl6" + repeat("A", 84) // 88 chars -> 66 bytes, wrong on purpose
	if err := ValidateKeys(p256dh, "c3VwZXJzZWNyZXQxMjM0NQ"); err == nil {
		t.Error("wrong-length p256dh accepted")
	}
	if err := ValidateKeys("not base64!!", "c3VwZXJzZWNyZXQxMjM0NQ"); err == nil {
		t.Error("non-base64 p256dh accepted")
	}
	valid := encodeLen(p256dhLen)
	if err := ValidateKeys(valid, encodeLen(authLen)); err != nil {
		t.Errorf("valid keys rejected: %v", err)
	}
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}

// encodeLen returns a base64url string that decodes to exactly n bytes.
func encodeLen(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i)
	}
	return b64RawURL(b)
}
