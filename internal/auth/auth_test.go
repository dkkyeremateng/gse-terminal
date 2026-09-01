package auth

import (
	"testing"
	"time"
)

func TestValidatePassword(t *testing.T) {
	cases := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{"empty", "", true},
		{"too short", "ab1", true},
		{"7 chars", "abcdef1", true},
		{"8 chars no digit", "abcdefgh", true},
		{"8 chars no letter", "12345678", true},
		{"all whitespace", "        ", true},
		{"valid 8 mixed", "abcdef12", false},
		{"valid 8 with symbols", "ab12!@#$", true}, // no letters req fails: has letters yes -> false. wait check
		{"long valid", "Correct-Horse-Battery-Staple-9", false},
	}
	// fix the symbols case manually: ab12!@#$ DOES have letters (a,b) and digits (1,2) so it should pass
	cases[7].wantErr = false
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePassword(tc.input)
			if (err != nil) != tc.wantErr {
				t.Errorf("ValidatePassword(%q) err=%v wantErr=%v", tc.input, err, tc.wantErr)
			}
		})
	}
}

func TestGenerateAndParseToken(t *testing.T) {
	svc := NewAuthService("test-secret-do-not-use-in-prod", false)
	tok, err := svc.GenerateToken(42, "alice", "admin")
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	claims, err := svc.ParseToken(tok)
	if err != nil {
		t.Fatalf("ParseToken: %v", err)
	}
	if uid, _ := claims["user_id"].(float64); int(uid) != 42 {
		t.Errorf("user_id = %v, want 42", claims["user_id"])
	}
	if claims["username"] != "alice" {
		t.Errorf("username = %v, want alice", claims["username"])
	}
	if claims["role"] != "admin" {
		t.Errorf("role = %v, want admin", claims["role"])
	}
	jti, _ := claims["jti"].(string)
	if len(jti) != 32 {
		t.Errorf("jti len = %d, want 32", len(jti))
	}
	expF, _ := claims["exp"].(float64)
	exp := time.Unix(int64(expF), 0)
	if d := time.Until(exp); d > AccessTokenTTL+1*time.Second || d < AccessTokenTTL-1*time.Minute {
		t.Errorf("exp delta = %v, want ~%v", d, AccessTokenTTL)
	}
}

func TestParseToken_RejectsTamperedSignature(t *testing.T) {
	svc := NewAuthService("test-secret", false)
	tok, _ := svc.GenerateToken(1, "x", "user")
	tampered := tok[:len(tok)-4] + "XXXX"
	if _, err := svc.ParseToken(tampered); err == nil {
		t.Error("expected error parsing tampered token")
	}
}

func TestNewJTI_Unique(t *testing.T) {
	a, err := newJTI()
	if err != nil {
		t.Fatalf("newJTI() a: %v", err)
	}
	b, err := newJTI()
	if err != nil {
		t.Fatalf("newJTI() b: %v", err)
	}
	if a == b || len(a) != 32 {
		t.Errorf("expected distinct 32-char ids, got %q vs %q", a, b)
	}
}
