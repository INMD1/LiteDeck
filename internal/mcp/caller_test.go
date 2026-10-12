package mcp

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"
)

// A server whose one tool reports who called it.
func callerServer(t *testing.T, opts Options) (string, func() Caller) {
	t.Helper()
	s := New()
	var seen Caller
	s.Register(Tool{
		Name:        "who",
		InputSchema: map[string]any{"type": "object"},
		Handler: func(ctx context.Context, _ map[string]any) (any, error) {
			seen = CallerFrom(ctx)
			return "ok", nil
		},
	})
	if opts.Limiter == nil {
		opts.Limiter = NewLimiter(1000, 1000)
	}
	l, url, err := s.Serve(opts)
	if err != nil {
		t.Fatalf("serve: %v", err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return url, func() Caller { return seen }
}

func postWith(t *testing.T, url, token, session, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if session != "" {
		req.Header.Set(SessionHeader, session)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	res.Body.Close()
	return res
}

const callWho = `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"who"}}`
const initialise = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`

// Each token is a client with its own label, and only a known token gets in.
func TestEachTokenCarriesItsLabel(t *testing.T) {
	tokens := map[string]string{"tok-a": "Default", "tok-b": "Codex - desktop"}
	url, who := callerServer(t, Options{Authorise: func(tok string) (string, bool) {
		l, ok := tokens[tok]
		return l, ok
	}})

	if res := postWith(t, url, "tok-b", "", callWho); res.StatusCode != http.StatusOK {
		t.Fatalf("a known token was refused: %d", res.StatusCode)
	}
	if got := who().Client; got != "Codex - desktop" {
		t.Errorf("client = %q", got)
	}
	if res := postWith(t, url, "tok-unknown", "", callWho); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("an unknown token got %d", res.StatusCode)
	}
}

// An initialize hands out a session id, and calls that carry it are grouped by it.
func TestInitializeStartsASessionTheClientKeeps(t *testing.T) {
	url, who := callerServer(t, Options{Token: "tok"})
	res := postWith(t, url, "tok", "", initialise)
	id := res.Header.Get(SessionHeader)
	if id == "" {
		t.Fatal("initialize gave the client no session id")
	}
	postWith(t, url, "tok", id, callWho)
	if got := who().Session; got != id {
		t.Errorf("a call carrying the session id was filed under %q", got)
	}

	// A second initialize is a second connection, and a second session.
	res2 := postWith(t, url, "tok", "", initialise)
	if res2.Header.Get(SessionHeader) == id {
		t.Error("two connections got the same session")
	}
}

// A client that keeps no session id gets one by idleness: calls close together
// share a session, and half an hour of silence starts the next.
func TestSessionsByIdlenessWhenTheClientKeepsNone(t *testing.T) {
	s := newSessions()
	now := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return now }

	a := s.forClient("Default")
	now = now.Add(10 * time.Minute)
	if b := s.forClient("Default"); b != a {
		t.Error("a call ten minutes later started a new session")
	}
	now = now.Add(29 * time.Minute)
	if c := s.forClient("Default"); c != a {
		t.Error("the gap is measured from the last call, not the first")
	}
	now = now.Add(31 * time.Minute)
	if d := s.forClient("Default"); d == a {
		t.Error("31 minutes of silence did not start a new session")
	}
	// Another client never shares one.
	if e := s.forClient("Codex"); e == a {
		t.Error("two clients shared a session")
	}
}

// Around sees the call on both sides: what was asked, and what came back.
func TestAroundSeesTheAnswer(t *testing.T) {
	var tool string
	var got any
	url, _ := callerServer(t, Options{Token: "tok",
		Around: func(ctx context.Context, name string, args map[string]any, call Call) (any, error) {
			tool = name
			v, err := call(ctx)
			got = v
			return v, err
		}})
	postWith(t, url, "tok", "", callWho)
	if tool != "who" || got != "ok" {
		t.Errorf("Around saw tool %q answer %v", tool, got)
	}
}
