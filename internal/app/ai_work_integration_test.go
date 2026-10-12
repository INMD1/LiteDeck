package app

import (
	"context"
	"path"
	"testing"

	"github.com/cpprhtn/LiteDeck/internal/config"
	"github.com/cpprhtn/LiteDeck/internal/mcp"
	"github.com/cpprhtn/LiteDeck/internal/rollback"
)

// The work graph's undo against a real server: the three states, and a
// session revert that walks a chain of writes back and leaves alone a file a
// person changed afterwards.
func TestSessionRevertAgainstARealServer(t *testing.T) {
	a := connectedApp(t)
	a.settings = config.OpenSettings(a.configDir)
	a.rollback = rollback.Open(a.configDir)
	a.SetMCPHost("fixture", true)
	a.SetMCPHostDelete("fixture", true)
	a.SetMCPWritePolicy("fixture", WriteBypass, 30)

	dir := scratchDir(t, a, "litedeck-ai-revert")
	chain, touched, gone := path.Join(dir, "chain.conf"), path.Join(dir, "touched.conf"), path.Join(dir, "gone.conf")
	for p, body := range map[string]string{chain: "v1\n", touched: "b0\n", gone: "keep me\n"} {
		if res := a.WriteTextFile("fixture", p, body); !res.OK {
			t.Fatalf("seed %s: %+v", p, res)
		}
	}

	byName := map[string]mcp.Tool{}
	for _, tool := range registered(t, a).Tools() {
		byName[tool.Name] = tool
	}
	ctx := mcp.WithCaller(context.Background(), mcp.Caller{Client: "default", Session: "s-int"})
	call := func(tool string, args map[string]any) AIRecord {
		t.Helper()
		args["hostId"] = "fixture"
		h := byName[tool].Handler
		if _, err := a.aroundAICall(ctx, tool, args, func(c context.Context) (any, error) { return h(c, args) }); err != nil {
			t.Fatalf("%s: %v", tool, err)
		}
		recs := a.AIRecords()
		return recs[len(recs)-1]
	}

	first := call("fs_write", map[string]any{"path": chain, "content": "v2\n"})
	second := call("fs_write", map[string]any{"path": chain, "content": "v3\n"})
	other := call("fs_write", map[string]any{"path": touched, "content": "b1\n"})
	del := call("fs_delete", map[string]any{"path": gone})
	// A person edits one of them afterwards.
	if res := a.WriteTextFile("fixture", touched, "b2 by hand\n"); !res.OK {
		t.Fatalf("hand edit: %+v", res)
	}

	for _, c := range []struct {
		rec  AIRecord
		want string
	}{
		{second, aiRevertible},
		{first, aiChanged}, // the second write changed it since
		{other, aiChanged}, // the person changed it since
		{del, aiRevertible},
	} {
		if v := a.AIChange(c.rec.ID); v.State != c.want {
			t.Errorf("%s (%s): state %s, want %s", c.rec.Target, c.rec.ID, v.State, c.want)
		}
	}
	if v := a.AIChange(second.ID); v.Before != "v2\n" || v.After != "v3\n" {
		t.Errorf("diff of the second write: %q → %q", v.Before, v.After)
	}

	rep := a.AIRevertSession("s-int")
	if len(rep.Reverted) != 3 {
		t.Errorf("reverted %v, want the two chain writes and the delete", rep.Reverted)
	}
	if len(rep.Skipped) != 1 || rep.Skipped[0].Path != touched || rep.Skipped[0].Reason != aiChanged {
		t.Errorf("skipped %+v, want only the hand-edited file", rep.Skipped)
	}
	read := func(p string) string {
		f, err := a.ReadTextFile("fixture", p)
		if err != nil {
			return "<" + err.Error() + ">"
		}
		return f.Content
	}
	if got := read(chain); got != "v1\n" {
		t.Errorf("chain = %q, want it walked all the way back to v1", got)
	}
	if got := read(touched); got != "b2 by hand\n" {
		t.Errorf("the hand edit was overwritten: %q", got)
	}
	if got := read(gone); got != "keep me\n" {
		t.Errorf("deleted file = %q, want it back", got)
	}
	for _, r := range []AIRecord{first, second, del} {
		if v := a.AIChange(r.ID); v.State != aiRestored {
			t.Errorf("%s after revert: %s", r.ID, v.State)
		}
	}
	// A single revert of the skipped one is refused without force, and done with it.
	if res := a.AIRevert(other.ID, false); res.OK {
		t.Error("reverting a file changed since went ahead without asking")
	}
	if res := a.AIRevert(other.ID, true); !res.OK {
		t.Errorf("forced revert: %+v", res)
	}
	if got := read(touched); got != "b0\n" {
		t.Errorf("after forced revert: %q", got)
	}
}
