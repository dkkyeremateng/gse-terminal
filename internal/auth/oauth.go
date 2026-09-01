package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

// OAuthUser is the provider-agnostic user profile returned after OAuth.
type OAuthUser struct {
	ProviderID    string // unique ID from the provider (e.g. Google "sub")
	Email         string
	EmailVerified bool
	Name          string
}

// OAuthProvider defines the interface every OAuth provider must implement.
type OAuthProvider interface {
	// Name returns the provider key stored in the DB (e.g. "google", "github").
	Name() string
	// DisplayName returns the human-readable label (e.g. "Google", "GitHub").
	DisplayName() string
	// AuthCodeURL returns the consent screen redirect URL with CSRF state.
	AuthCodeURL(state string) string
	// Exchange trades an authorization code for tokens.
	Exchange(ctx context.Context, code string) (*oauth2.Token, error)
	// FetchUser retrieves the user profile using the access token.
	FetchUser(ctx context.Context, token *oauth2.Token) (*OAuthUser, error)
}

// GenerateState returns a cryptographically random 32-byte hex string
// for the OAuth state parameter (CSRF protection).
func GenerateState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("entropy failure generating oauth state: %w", err)
	}
	return hex.EncodeToString(b), nil
}

// ── Google Provider ───────────────────────────────────────────────────

type GoogleProvider struct {
	config *oauth2.Config
}

func NewGoogleProvider(clientID, clientSecret, redirectURL string) *GoogleProvider {
	return &GoogleProvider{
		config: &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			RedirectURL:  redirectURL,
			Scopes:       []string{"openid", "email", "profile"},
			Endpoint:     google.Endpoint,
		},
	}
}

func (g *GoogleProvider) Name() string        { return "google" }
func (g *GoogleProvider) DisplayName() string { return "Google" }

func (g *GoogleProvider) AuthCodeURL(state string) string {
	return g.config.AuthCodeURL(state, oauth2.AccessTypeOnline)
}

func (g *GoogleProvider) Exchange(ctx context.Context, code string) (*oauth2.Token, error) {
	return g.config.Exchange(ctx, code)
}

func (g *GoogleProvider) FetchUser(ctx context.Context, token *oauth2.Token) (*OAuthUser, error) {
	client := g.config.Client(ctx, token)
	resp, err := client.Get("https://www.googleapis.com/oauth2/v3/userinfo")
	if err != nil {
		return nil, fmt.Errorf("userinfo request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("userinfo status %d: %s", resp.StatusCode, body)
	}

	var raw struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return nil, fmt.Errorf("decode userinfo: %w", err)
	}
	if raw.Sub == "" {
		return nil, fmt.Errorf("empty google sub claim")
	}
	return &OAuthUser{
		ProviderID:    raw.Sub,
		Email:         raw.Email,
		EmailVerified: raw.EmailVerified,
		Name:          raw.Name,
	}, nil
}
