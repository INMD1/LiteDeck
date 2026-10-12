package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cpprhtn/LiteDeck/internal/mcp"
	"github.com/cpprhtn/LiteDeck/internal/rollback"
)

// callAs runs a fake tool call through the recorder as a given client and
// session, and returns the record it finished with.
func callAs(t *testing.T, a *App, client, session, tool string, args map[string]any,
	run func(ctx context.Context) (any, error)) AIRecord {
	t.Helper()
	ctx := mcp.WithCaller(context.Background(), mcp.Caller{Client: client, Session: session})
	_, _ = a.aroundAICall(ctx, tool, args, run)
	recs := a.AIRecords()
	if len(recs) == 0 {
		t.Fatal("no record was made")
	}
	return recs[len(recs)-1]
}

// Every call is recorded with who made it, in which session, what it was
// about, and how it ended — and the Command Log row carries the same record.
func TestEveryToolCallIsRecorded(t *testing.T) {
	a := appWithSettings(t)
	seedSharedHost(t, a)

	r := callAs(t, a, "default", "s-1", "svc_logs",
		map[string]any{"hostId": "h1", "unit": "nginx.service"},
		func(context.Context) (any, error) { return []string{"line"}, nil })
	if r.Kind != aiRead || r.Target != "nginx.service" || r.Result != "ok" ||
		r.Session != "s-1" || r.Client != "default" || r.HostID != "h1" {
		t.Errorf("read record: %+v", r)
	}
	if r.Ended < r.At || r.At == 0 {
		t.Errorf("times: at %d ended %d", r.At, r.Ended)
	}

	// A tool that answers {"ok": false} failed, whatever the transport says.
	r = callAs(t, a, "default", "s-1", "svc_control",
		map[string]any{"hostId": "h1", "unit": "nginx.service", "action": "restart"},
		func(context.Context) (any, error) {
			return map[string]any{"ok": false, "error": "Job for nginx.service failed"}, nil
		})
	if r.Kind != aiService || r.Action != "restart" || r.Result != "failed" || r.Error == "" {
		t.Errorf("failed service record: %+v", r)
	}

	// The row in the Command Log carries the finished record.
	var row *CommandEntry
	for _, e := range a.CommandLog() {
		if e.AI != nil && e.AI.ID == r.ID {
			e := e
			row = &e
		}
	}
	if row == nil || row.AI.Result != "failed" {
		t.Fatalf("Command Log row: %+v", row)
	}
}

// A change the person refused is recorded as declined, not as a failure: the
// graph draws the two differently, and "I said no" is not an error.
func TestDeclinedIsNotFailed(t *testing.T) {
	a := appWithSettings(t)
	seedSharedHost(t, a)
	a.SetMCPWritePolicy("h1", WriteStrict, 0)
	defer WriteApprovalTimeoutForTest(20 * time.Millisecond)()

	r := callAs(t, a, "default", "s-1", "svc_control",
		map[string]any{"hostId": "h1", "unit": "nginx", "action": "restart"},
		func(ctx context.Context) (any, error) {
			_, err := a.approveWrite(writeRequest{ctx: ctx, hostID: "h1", tool: "svc_control",
				summary: "restart nginx", command: "systemctl restart -- nginx"})
			return nil, err
		})
	if r.Result != "declined" || r.Approval != string(outcomeTimeout) {
		t.Errorf("record: %+v", r)
	}
	if r.Command != "systemctl restart -- nginx" {
		t.Errorf("command = %q", r.Command)
	}
}

// The journal is what lets the graph reach back a month: it survives a
// restart, sheds what is older than that, and is private to the user.
func TestJournalKeepsAMonth(t *testing.T) {
	dir := t.TempDir()
	j := openAIJournal(dir)
	old := time.Now().Add(-31 * 24 * time.Hour).UnixMilli()
	j.add(AIRecord{ID: "old", At: old, Tool: "fs_read", Kind: aiRead, Result: "ok"})
	j.add(AIRecord{ID: "new", At: time.Now().UnixMilli(), Tool: "fs_read", Kind: aiRead, Result: "ok"})

	info, err := os.Stat(filepath.Join(dir, "ai-log.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("ai-log.jsonl is %v, want 0600", info.Mode().Perm())
	}

	again := openAIJournal(dir)
	recs := again.all()
	if len(recs) != 1 || recs[0].ID != "new" {
		t.Fatalf("after restart: %+v", recs)
	}
	// And the file itself was rewritten without the old line.
	if again2 := openAIJournal(dir); len(again2.all()) != 1 {
		t.Error("the aged-out record came back")
	}
}

// A line that will not parse costs that line, not the month around it.
func TestJournalSurvivesABadLine(t *testing.T) {
	dir := t.TempDir()
	j := openAIJournal(dir)
	j.add(AIRecord{ID: "a", At: time.Now().UnixMilli(), Tool: "fs_read", Kind: aiRead, Result: "ok"})
	f, _ := os.OpenFile(filepath.Join(dir, "ai-log.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString("{not json\n")
	f.Close()
	j2 := openAIJournal(dir)
	j2.add(AIRecord{ID: "b", At: time.Now().UnixMilli(), Tool: "fs_read", Kind: aiRead, Result: "ok"})
	if got := openAIJournal(dir).all(); len(got) != 2 {
		t.Errorf("records = %+v", got)
	}
}

// Somebody who set up MCP before tokens had names changes nothing and keeps
// working. A named token works alongside it, and stops the moment it is removed.
func TestNamedTokensSitBesideTheOriginal(t *testing.T) {
	a := appWithSettings(t)
	a.SetMCPEnabled(true)
	t.Cleanup(a.stopMCP)
	original := a.settings.Get().MCP.Token
	if original == "" {
		t.Fatal("no default token")
	}
	if id, ok := a.mcpAuthorise(original); !ok || id != defaultMCPClient {
		t.Fatalf("the original token: %q %v", id, ok)
	}

	st := a.AddMCPClient("  Codex - desktop  ")
	if len(st.Clients) != 1 || st.Clients[0].Label != "Codex - desktop" || st.Clients[0].Token == "" {
		t.Fatalf("clients: %+v", st.Clients)
	}
	c := st.Clients[0]
	if c.Snippet == "" || c.CodexSnippet == "" {
		t.Error("a new client needs its own lines to paste")
	}
	if id, ok := a.mcpAuthorise(c.Token); !ok || id != c.ID {
		t.Errorf("the new token: %q %v", id, ok)
	}
	if a.mcpClientLabel(c.ID) != "Codex - desktop" {
		t.Errorf("label = %q", a.mcpClientLabel(c.ID))
	}
	if _, ok := a.mcpAuthorise(original); !ok {
		t.Error("adding a client broke the original token")
	}
	if st := a.AddMCPClient("   "); st.Error == "" {
		t.Error("a client with no name was accepted")
	}

	a.RemoveMCPClient(c.ID)
	if _, ok := a.mcpAuthorise(c.Token); ok {
		t.Error("a removed token still works")
	}
	if _, ok := a.mcpAuthorise(original); !ok {
		t.Error("removing a client broke the original token")
	}
}

// The undo copies' window is a setting, a week unless changed, and bounded.
func TestRetentionIsASetting(t *testing.T) {
	a := appWithSettings(t)
	if st := a.MCPState(); st.KeepDays != 7 || st.KeepMB != 256 {
		t.Errorf("defaults: %d days %d MB", st.KeepDays, st.KeepMB)
	}
	a.applyRetention()
	if age, _ := a.rollback.Limits(); age != 7*24*time.Hour {
		t.Errorf("store window = %v", age)
	}
	st := a.SetMCPRetention(30, 1024)
	if st.KeepDays != 30 || st.KeepMB != 1024 {
		t.Errorf("after set: %+v", st)
	}
	if age, size := a.rollback.Limits(); age != 30*24*time.Hour || size != 1024<<20 {
		t.Errorf("store limits = %v, %d", age, size)
	}
	if st := a.SetMCPRetention(10000, 1); st.KeepDays != maxKeepDays || st.KeepMB != minKeepMB {
		t.Errorf("bounds: %+v", st)
	}
}

// The states that need no server: what was never applied, what cannot be put
// back, what aged out, what was already put back, and an offline host.
func TestChangeStatesWithoutAServer(t *testing.T) {
	a := appWithSettings(t)
	seedSharedHost(t, a)

	if v := a.aiChange(AIRecord{Kind: aiService, Result: "ok"}, true); v.State != aiIrreversible {
		t.Errorf("restart: %s", v.State)
	}
	if v := a.aiChange(AIRecord{Kind: aiFileWrite, Result: "declined"}, true); v.State != aiNotApplied {
		t.Errorf("declined write: %s", v.State)
	}
	// "Already has these contents" succeeds and writes nothing.
	if v := a.aiChange(AIRecord{Kind: aiFileWrite, Result: "ok"}, true); v.State != aiNotApplied {
		t.Errorf("no-op write: %s", v.State)
	}
	if v := a.aiChange(AIRecord{Kind: aiFileWrite, Result: "ok", Changed: true, Snapshot: "999"}, true); v.State != aiExpired {
		t.Errorf("missing copy: %s", v.State)
	}

	snap := a.recordAIChange("h1", "/etc/nginx/nginx.conf", rollback.ActionWrite, []byte("old\n"), false)
	a.recordAIAfter(snap, []byte("new\n"))
	rec := AIRecord{Kind: aiFileWrite, Result: "ok", Changed: true, Snapshot: snap,
		HostID: "h1", Target: "/etc/nginx/nginx.conf", AfterHash: contentHash([]byte("new\n"))}

	v := a.aiChange(rec, true)
	if v.State != aiOffline {
		t.Errorf("not connected: %s", v.State)
	}
	if !v.HasDiff || v.Before != "old\n" || v.After != "new\n" {
		t.Errorf("diff: %+v", v)
	}

	if err := a.rollback.MarkRestored(snap); err != nil {
		t.Fatal(err)
	}
	if v := a.aiChange(rec, true); v.State != aiRestored {
		t.Errorf("after restore: %s", v.State)
	}
	// And it is off the undo list, which shows only what is outstanding.
	for _, c := range a.MCPChanges("h1") {
		if c.ID == snap {
			t.Error("a restored change is still on the undo list")
		}
	}
	if res := a.RestoreMCPChange(snap); res.OK {
		t.Error("restoring twice was accepted")
	}
}

// A session revert counts what it cannot touch, so the person knows a restart
// or a command in that session stays done.
func TestSessionRevertCountsTheIrreversible(t *testing.T) {
	a := appWithSettings(t)
	j := a.aiLog()
	now := time.Now().UnixMilli()
	j.add(AIRecord{ID: "1", At: now, Session: "s", Kind: aiService, Result: "ok"})
	j.add(AIRecord{ID: "2", At: now, Session: "s", Kind: aiCommand, Result: "ok"})
	j.add(AIRecord{ID: "3", At: now, Session: "s", Kind: aiCommand, Result: "declined"})
	j.add(AIRecord{ID: "4", At: now, Session: "other", Kind: aiProcess, Result: "ok"})
	rep := a.AIRevertSession("s")
	if rep.Irreversible != 2 {
		t.Errorf("irreversible = %d, want 2 (a declined command did nothing)", rep.Irreversible)
	}
	if len(rep.Reverted) != 0 || len(rep.Skipped) != 0 {
		t.Errorf("report: %+v", rep)
	}
}
