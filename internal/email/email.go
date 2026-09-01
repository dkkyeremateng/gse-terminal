// Package email provides a narrow SMTP-backed outgoing mail abstraction.
//
// The Sender interface lives here (not in internal/alerts) so that future
// callers — password reset emails, digest summaries, admin notifications —
// can depend on the same contract without an alerts package import.
//
// Design: stdlib net/smtp only. No third-party provider SDKs. Any SMTP
// relay (Google Workspace, SES, Postmark, self-hosted) that speaks STARTTLS
// on the configured port works. The package is intentionally feature-light;
// callers construct their own subject + body strings.
package email

import (
	"context"
	"fmt"
	"log/slog"
	"net/smtp"
	"strings"
	"time"
)

// Sender is the minimal interface the rest of the codebase depends on.
// Implementations must be safe for concurrent use by multiple goroutines
// and must honour ctx cancellation during the dial+auth phase.
type Sender interface {
	// Send delivers an HTML + plain-text email. plainBody is the
	// text/plain alternative shown to mail clients that can't render
	// HTML; pass "" to have it auto-derived from htmlBody.
	Send(ctx context.Context, to, subject, htmlBody, plainBody string) error
}

// Config holds the SMTP credentials + envelope metadata. All fields are
// required for SMTPSender; callers should gate construction on
// config.EmailEnabled() from the main config package.
type Config struct {
	Host     string // smtp.example.com
	Port     int    // 587 (STARTTLS) or 465 (implicit TLS — unsupported, use 587)
	Username string // SMTP auth user (often the From address)
	Password string // SMTP auth password or API key for providers
	From     string // "Display Name <addr@example.com>" or just "addr@example.com"
}

// NewSender returns an SMTP-backed Sender when cfg.Host is set, or a
// no-op sender when it isn't. Callers can always unconditionally call
// Send — the noop path logs at debug and returns nil so alert rules
// continue to fire in-app even when email is disabled.
func NewSender(cfg Config, log *slog.Logger) Sender {
	if cfg.Host == "" || cfg.Port == 0 || cfg.From == "" {
		return &noopSender{log: log}
	}
	return &smtpSender{cfg: cfg, log: log}
}

// ─── noop ───────────────────────────────────────────────────────────────────

type noopSender struct{ log *slog.Logger }

func (n *noopSender) Send(_ context.Context, to, subject, _, _ string) error {
	if n.log != nil {
		n.log.Debug("email disabled — skipping send", "to", to, "subject", subject)
	}
	return nil
}

// ─── SMTP ───────────────────────────────────────────────────────────────────

type smtpSender struct {
	cfg Config
	log *slog.Logger
}

// Send performs a STARTTLS-upgraded SMTP session with PLAIN auth. Uses a
// 15s overall dial+write deadline via ctx; if ctx is already cancelled the
// call returns immediately without opening a socket.
func (s *smtpSender) Send(ctx context.Context, to, subject, htmlBody, plainBody string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if to == "" {
		return fmt.Errorf("email: empty recipient")
	}
	if plainBody == "" {
		plainBody = stripHTML(htmlBody)
	}

	addr := fmt.Sprintf("%s:%d", s.cfg.Host, s.cfg.Port)
	auth := smtp.PlainAuth("", s.cfg.Username, s.cfg.Password, s.cfg.Host)

	boundary := fmt.Sprintf("gse_boundary_%d", time.Now().UnixNano())
	msg := buildMIME(s.cfg.From, to, subject, htmlBody, plainBody, boundary)

	// Run the send on a goroutine with a context-bounded result channel
	// so ctx.Done() aborts a stalled SMTP handshake. Pure net/smtp has no
	// native context plumbing; this is the idiomatic wrapper.
	done := make(chan error, 1)
	go func() {
		done <- smtp.SendMail(addr, auth, senderAddr(s.cfg.From), []string{to}, msg)
	}()

	select {
	case err := <-done:
		if err != nil {
			return fmt.Errorf("smtp send: %w", err)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ─── helpers ────────────────────────────────────────────────────────────────

// buildMIME assembles a multipart/alternative message with both text/plain
// and text/html parts. Most email clients render the HTML part; text/plain
// is a fallback + improves spam scoring.
func buildMIME(from, to, subject, html, plain, boundary string) []byte {
	var b strings.Builder
	b.WriteString("From: ")
	b.WriteString(from)
	b.WriteString("\r\n")
	b.WriteString("To: ")
	b.WriteString(to)
	b.WriteString("\r\n")
	b.WriteString("Subject: ")
	b.WriteString(subject)
	b.WriteString("\r\n")
	b.WriteString("MIME-Version: 1.0\r\n")
	b.WriteString("Content-Type: multipart/alternative; boundary=\"")
	b.WriteString(boundary)
	b.WriteString("\"\r\n\r\n")

	// Plain part first — ordering matters; mail clients pick the LAST
	// part they can render, so HTML-capable clients get HTML.
	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("\r\nContent-Type: text/plain; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(plain)
	b.WriteString("\r\n\r\n")

	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("\r\nContent-Type: text/html; charset=\"utf-8\"\r\n")
	b.WriteString("Content-Transfer-Encoding: 8bit\r\n\r\n")
	b.WriteString(html)
	b.WriteString("\r\n\r\n")

	b.WriteString("--")
	b.WriteString(boundary)
	b.WriteString("--\r\n")
	return []byte(b.String())
}

// senderAddr extracts the bare <addr@host> from a "Display <addr@host>"
// or returns the input unchanged if it's already bare. Required because
// SMTP SendMail expects the envelope-from as a naked address.
func senderAddr(from string) string {
	if lt := strings.LastIndex(from, "<"); lt >= 0 {
		if gt := strings.LastIndex(from, ">"); gt > lt {
			return from[lt+1 : gt]
		}
	}
	return from
}

// stripHTML returns a crude text-only fallback for the plain part when
// the caller doesn't supply one. Not a real HTML parser; just collapses
// whitespace so the output is readable in terminals / SMS previews.
func stripHTML(html string) string {
	inTag := false
	var b strings.Builder
	for _, r := range html {
		switch r {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				b.WriteRune(r)
			}
		}
	}
	out := strings.Join(strings.Fields(b.String()), " ")
	return out
}

// Compile-time check: smtpSender satisfies Sender.
var _ Sender = (*smtpSender)(nil)
var _ Sender = (*noopSender)(nil)
