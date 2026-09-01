package auth

import "context"

// User is a snapshot of the authenticated principal extracted from the JWT
// claims by Middleware. A guest request will resolve to a User where IsGuest()
// returns true; this avoids nil checks throughout the handler layer.
type User struct {
	ID       int
	Username string
	Role     string
}

// IsGuest returns true when the request has no valid authenticated session.
func (u *User) IsGuest() bool { return u == nil || u.Username == "" }

// IsAdmin returns true when the principal has the admin role.
func (u *User) IsAdmin() bool { return u != nil && u.Role == "admin" }

// IsPro returns true when the principal has the pro role.
func (u *User) IsPro() bool { return u != nil && u.Role == "pro" }

// FromContext extracts the User stored on the request context. It always
// returns a non-nil pointer; the zero value represents a guest.
func FromContext(ctx context.Context) *User {
	u := &User{}
	if id, ok := ctx.Value(UserIDKey).(int); ok {
		u.ID = id
	}
	if username, ok := ctx.Value(UsernameKey).(string); ok {
		u.Username = username
	}
	if role, ok := ctx.Value(RoleKey).(string); ok {
		u.Role = role
	}
	return u
}
