package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Who is calling, and as part of what.
//
// Two facts the AI work graph needs and nothing else here does: which AI client
// made a call — by the label on the token it presented — and which session the
// call belongs to, so a night's work comes out as one piece rather than as a
// flat list of tool calls.
//
// # Sessions
//
// MCP's streamable HTTP transport has its own session: the server may hand a
// client an `Mcp-Session-Id` when it initialises, and the client sends it back
// on every request after that. That is exactly a client connection, which is
// what a session should be, and it is used whenever the client sends one.
//
// A client that does not gets sessions by idleness instead: everything from one
// token is one session until it has been quiet for half an hour. Crude, but a
// session boundary that falls in the middle of a coffee break is the right
// place for one anyway.

// Caller identifies who made a tool call.
type Caller struct {
	// Client is the token's label — "Claude Code - MacBook", or "Default" for
	// the token every install started with. A label for the record only: two
	// tokens are never allowed to do different things.
	Client string
	// Session groups the calls of one connection.
	Session string
}

type callerKey struct{}

// WithCaller attaches a caller to a context. Exported for tests that call tool
// handlers directly.
func WithCaller(ctx context.Context, c Caller) context.Context {
	return context.WithValue(ctx, callerKey{}, c)
}

// CallerFrom returns the caller a request carried, or the zero value.
func CallerFrom(ctx context.Context) Caller {
	c, _ := ctx.Value(callerKey{}).(Caller)
	return c
}

// SessionHeader is the streamable HTTP transport's session header.
const SessionHeader = "Mcp-Session-Id"

// idleGap is how long one token may go quiet before its next call starts a new
// session, for a client that does not send a session id.
const idleGap = 30 * time.Minute

// sessions hands out session ids for clients that do not keep their own.
type sessions struct {
	mu   sync.Mutex
	last map[string]idleSession // by client label
	now  func() time.Time
}

type idleSession struct {
	id   string
	seen time.Time
}

func newSessions() *sessions {
	return &sessions{last: map[string]idleSession{}, now: time.Now}
}

// forClient returns the current idle-based session for a client, starting a new
// one after idleGap of silence.
func (s *sessions) forClient(client string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	cur, ok := s.last[client]
	if !ok || now.Sub(cur.seen) > idleGap {
		cur.id = newSessionID()
	}
	cur.seen = now
	s.last[client] = cur
	return cur.id
}

func newSessionID() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		// A session id is a label, not a secret. A clock fallback keeps calls
		// grouped rather than failing the call over it.
		return "s-" + time.Now().UTC().Format("20060102T150405.000000000")
	}
	return "s-" + hex.EncodeToString(b)
}
