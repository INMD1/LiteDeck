package app

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/cpprhtn/LiteDeck/internal/config"
	"github.com/cpprhtn/LiteDeck/internal/i18n"
	"github.com/cpprhtn/LiteDeck/internal/mcp"
)

// Named tokens, one per AI client (§6.3 of the next spec).
//
// The work graph has to say which AI did something, and the protocol does not
// say in any way worth trusting — a client's name in initialize is whatever it
// chooses to send. A token is something the person handed out themselves, so a
// token per client is the honest answer to "who".
//
// The names are for the record only. Every token reaches exactly what the
// original one does: a second permission system would be the new restriction
// this work promised not to add, and one nobody would know they had to set.
//
// The original token stays where it was in settings.json and is shown as the
// default client. Somebody who updates and changes nothing keeps working with
// the line they pasted months ago.

// defaultMCPClient is the ID the original token answers to.
const defaultMCPClient = "default"

// MCPClientView is one extra token, as the panel shows it.
type MCPClientView struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Token        string `json:"token"`
	Created      int64  `json:"created,omitempty"`
	Snippet      string `json:"snippet,omitempty"`
	CodexSnippet string `json:"codexSnippet,omitempty"`
}

// mcpAuthorise is the listener's token check. Every token is compared, so the
// time taken does not say which one — if any — matched.
func (a *App) mcpAuthorise(token string) (string, bool) {
	if a.settings == nil || token == "" {
		return "", false
	}
	m := a.settings.Get().MCP
	id := ""
	if m.Token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(m.Token)) == 1 {
		id = defaultMCPClient
	}
	for _, c := range m.Clients {
		if c.Token != "" && subtle.ConstantTimeCompare([]byte(token), []byte(c.Token)) == 1 {
			id = c.ID
		}
	}
	return id, id != ""
}

// mcpClientLabel is a client's name now. Empty for the default client, whose
// name is drawn in the reader's language rather than stored in the writer's.
func (a *App) mcpClientLabel(id string) string {
	if a.settings == nil || id == "" || id == defaultMCPClient {
		return ""
	}
	for _, c := range a.settings.Get().MCP.Clients {
		if c.ID == id {
			return c.Label
		}
	}
	return ""
}

// claudeSnippet is the line that registers this app with Claude Code.
func claudeSnippet(token, url string) string {
	return fmt.Sprintf(
		"claude mcp add --transport http litedeck %s --header \"Authorization: Bearer %s\"",
		url, token)
}

func (a *App) mcpClientViews(m config.MCPSettings, url string) []MCPClientView {
	out := make([]MCPClientView, 0, len(m.Clients))
	for _, c := range m.Clients {
		v := MCPClientView{ID: c.ID, Label: c.Label, Token: c.Token, Created: c.Created}
		if url != "" {
			v.Snippet = claudeSnippet(c.Token, url)
			v.CodexSnippet = codexSnippet(c.Token, url, runtime.GOOS)
		}
		out = append(out, v)
	}
	return out
}

// maxClientLabel bounds a client's name. It lands in a session list and on
// graph nodes, where a paragraph would push everything else out.
const maxClientLabel = 60

// AddMCPClient issues a token for one more AI client.
func (a *App) AddMCPClient(label string) MCPStatus {
	if a.settings == nil {
		return a.MCPState()
	}
	label = strings.TrimSpace(label)
	if label == "" {
		out := a.MCPState()
		out.Error = i18n.S("이름을 입력하세요")
		return out
	}
	if utf8.RuneCountInString(label) > maxClientLabel {
		r := []rune(label)
		label = string(r[:maxClientLabel])
	}
	token, err := mcp.NewToken()
	if err != nil {
		out := a.MCPState()
		out.Error = err.Error()
		return out
	}
	idb := make([]byte, 6)
	if _, err := rand.Read(idb); err != nil {
		out := a.MCPState()
		out.Error = err.Error()
		return out
	}
	m := a.settings.Get().MCP
	// A fresh slice: Get hands back the stored one, and appending in place
	// could write into it under another reader.
	clients := append(append([]config.MCPClient(nil), m.Clients...), config.MCPClient{
		ID: "c-" + hex.EncodeToString(idb), Label: label, Token: token, Created: time.Now().Unix(),
	})
	m.Clients = clients
	return a.saveMCP(m)
}

// RemoveMCPClient revokes one client's token at once. The default token is not
// removable here — it is rotated, which RotateMCPToken does.
func (a *App) RemoveMCPClient(id string) MCPStatus {
	if a.settings == nil {
		return a.MCPState()
	}
	m := a.settings.Get().MCP
	kept := make([]config.MCPClient, 0, len(m.Clients))
	for _, c := range m.Clients {
		if c.ID != id {
			kept = append(kept, c)
		}
	}
	m.Clients = kept
	return a.saveMCP(m)
}

// RenameMCPClient changes what a client is called from now on. Records already
// made keep the name they were made under.
func (a *App) RenameMCPClient(id, label string) MCPStatus {
	if a.settings == nil {
		return a.MCPState()
	}
	label = strings.TrimSpace(label)
	if label == "" {
		out := a.MCPState()
		out.Error = i18n.S("이름을 입력하세요")
		return out
	}
	if utf8.RuneCountInString(label) > maxClientLabel {
		label = string([]rune(label)[:maxClientLabel])
	}
	m := a.settings.Get().MCP
	clients := append([]config.MCPClient(nil), m.Clients...)
	for i := range clients {
		if clients[i].ID == id {
			clients[i].Label = label
		}
	}
	m.Clients = clients
	return a.saveMCP(m)
}

// Retention bounds, in the units the settings screen offers.
const (
	minKeepDays     = 1
	maxKeepDays     = 90
	defaultKeepDays = 7
	minKeepMB       = 16
	maxKeepMB       = 4096
	defaultKeepMB   = 256
)

func keepDays(m config.MCPSettings) int {
	if m.KeepDays <= 0 {
		return defaultKeepDays
	}
	return max(minKeepDays, min(maxKeepDays, m.KeepDays))
}

func keepMB(m config.MCPSettings) int {
	if m.KeepMB <= 0 {
		return defaultKeepMB
	}
	return max(minKeepMB, min(maxKeepMB, m.KeepMB))
}

// applyRetention hands the stored limits to the undo store.
func (a *App) applyRetention() {
	if a.rollback == nil || a.settings == nil {
		return
	}
	m := a.settings.Get().MCP
	a.rollback.SetLimits(time.Duration(keepDays(m))*24*time.Hour, int64(keepMB(m))<<20)
}

// SetMCPRetention sets how long undo copies are kept and how much room they
// may take. Shortening the window drops older copies at once.
func (a *App) SetMCPRetention(days, mb int) MCPStatus {
	if a.settings == nil {
		return a.MCPState()
	}
	m := a.settings.Get().MCP
	m.KeepDays = max(minKeepDays, min(maxKeepDays, days))
	m.KeepMB = max(minKeepMB, min(maxKeepMB, mb))
	out := a.saveMCP(m)
	a.applyRetention()
	return out
}

// saveMCP stores the settings and tells the open views.
func (a *App) saveMCP(m config.MCPSettings) MCPStatus {
	if err := a.settings.SetMCP(m); err != nil {
		out := a.MCPState()
		out.Error = err.Error()
		return out
	}
	out := a.MCPState()
	a.emitMCPState(out)
	return out
}
