package app

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/cpprhtn/LiteDeck/internal/i18n"
	"github.com/cpprhtn/LiteDeck/internal/mcp"
	"github.com/cpprhtn/LiteDeck/internal/sshcore"
)

// The record behind the AI work graph (§6.3 of the next spec).
//
// # What this adds, and what it does not
//
// Nothing here stops an AI from doing anything. The approval modes, the
// per-host switches and the sudo lock are where they were and behave as they
// did. What is new is a record of each tool call precise enough to draw — which
// client, which session, what it touched, how it ended — and, for a file, the
// copy of what was written so the change can be shown as a diff and checked
// against what is on the server now.
//
// # Where it lives
//
// On the Command Log row the call already produced: the AI row carries the
// record in its `ai` field. The Command Log is memory only, and the graph has to
// reach back a month, so the AI rows — and only those — are also appended to
// ai-log.jsonl beside the settings. What a person does in the app is not
// written down anywhere; that has not changed.

// AI work kinds. The graph draws each one differently, and only the file kinds
// can be put back.
const (
	aiRead       = "read"
	aiFileWrite  = "file_write"
	aiFileDelete = "file_delete"
	aiService    = "service"
	aiProcess    = "process"
	aiContainer  = "container"
	aiCommand    = "command"
	// aiRestore is a person putting a file back. Recorded so "this was undone"
	// survives a restart; it is not an AI's work and is not drawn as a node.
	aiRestore = "restore"
)

// AIRecord is one thing an AI did through LiteDeck.
type AIRecord struct {
	ID string `json:"id"`
	// At and Ended are unix milliseconds.
	At     int64  `json:"at"`
	Ended  int64  `json:"ended,omitempty"`
	HostID string `json:"hostId,omitempty"`
	// Client is the token's ID ("default" for the original token), and
	// ClientLabel its name at the time — kept because a renamed or removed
	// token should not rewrite who did last week's work.
	Client      string `json:"client,omitempty"`
	ClientLabel string `json:"clientLabel,omitempty"`
	Session     string `json:"session,omitempty"`
	Tool        string `json:"tool"`
	Kind        string `json:"kind"`
	// Target is what was touched: a path, a unit, a container, a PID, a
	// command line. Empty for reads that are not about one thing.
	Target string `json:"target,omitempty"`
	Action string `json:"action,omitempty"`
	// Result is "running", "ok", "failed" or "declined".
	Result   string `json:"result"`
	Approval string `json:"approval,omitempty"`
	Exit     *int   `json:"exit,omitempty"`
	Error    string `json:"error,omitempty"`
	// Command is the command line shown at approval, where there was one.
	Command string `json:"command,omitempty"`
	// Output is the head of a command's output. Reads keep none: the answer
	// went to the model, and a month of file contents is not a log.
	Output string `json:"output,omitempty"`
	// Snapshot is the undo copy's ID, AfterHash the SHA-256 of what was
	// written — empty after a delete. Comparing it with the file on the server
	// is how the graph knows whether anything changed the file since.
	Snapshot string `json:"snapshot,omitempty"`
	// Changed is set once the file was actually written or removed. A write
	// of what was already there succeeds and changes nothing.
	Changed   bool   `json:"changed,omitempty"`
	Created   bool   `json:"created,omitempty"`
	AfterHash string `json:"afterHash,omitempty"`
	// Restores names the snapshot a restore put back.
	Restores string `json:"restores,omitempty"`
}

// aiKind sorts a tool into the kinds the graph knows. Anything not listed is a
// read: every tool that changes something is named here, and a new write tool
// that is not would show as a read — the change it makes would still be in the
// Command Log, which is where the approval dialog sends it.
func aiKind(tool string) string {
	switch tool {
	case "fs_write":
		return aiFileWrite
	case "fs_delete":
		return aiFileDelete
	case "svc_control":
		return aiService
	case "container_control":
		return aiContainer
	case "proc_signal":
		return aiProcess
	case "run_command":
		return aiCommand
	}
	return aiRead
}

// aiTarget is what a call was about, from its arguments.
func aiTarget(tool string, args map[string]any) (target, action string) {
	switch tool {
	case "fs_write", "fs_delete", "fs_read", "fs_list":
		return str(args, "path"), ""
	case "svc_control":
		return str(args, "unit"), str(args, "action")
	case "svc_logs":
		return str(args, "unit"), ""
	case "container_control":
		return str(args, "id"), str(args, "action")
	case "container_logs":
		return str(args, "id"), ""
	case "proc_signal":
		sig := str(args, "signal")
		if sig == "" {
			sig = "TERM"
		}
		if f, ok := args["pid"].(float64); ok {
			return strconv.Itoa(int(f)), sig
		}
		return "", sig
	case "run_command":
		return clipArg(str(args, "command")), ""
	}
	return "", ""
}

/* ---------------------------------------------- what a handler reports back */

// aiNote is how a tool tells the record what only it knows: the approval
// outcome, the undo copy it made, what it wrote. It rides on the call's
// context, so a tool that has nothing to say needs no change at all.
type aiNote struct {
	mu        sync.Mutex
	approval  string
	command   string
	snapshot  string
	changed   bool
	created   bool
	afterHash string
	exit      *int
	output    string
}

type aiNoteKey struct{}

func withAINote(ctx context.Context) (context.Context, *aiNote) {
	n := &aiNote{}
	return context.WithValue(ctx, aiNoteKey{}, n), n
}

// aiNoteFrom returns the call's note, or nil — every method is safe on nil, so
// a write made from the GUI or a test, with no record behind it, just skips.
func aiNoteFrom(ctx context.Context) *aiNote {
	if ctx == nil {
		return nil
	}
	n, _ := ctx.Value(aiNoteKey{}).(*aiNote)
	return n
}

func (n *aiNote) setApproval(out approvalOutcome, command string) {
	if n == nil {
		return
	}
	n.mu.Lock()
	n.approval, n.command = string(out), command
	n.mu.Unlock()
}

func (n *aiNote) setChange(snapshot string, created bool, after []byte, deleted bool) {
	if n == nil {
		return
	}
	n.mu.Lock()
	n.snapshot, n.created, n.changed = snapshot, created, true
	if !deleted {
		n.afterHash = contentHash(after)
	}
	n.mu.Unlock()
}

func (n *aiNote) setRun(exit int, output string) {
	if n == nil {
		return
	}
	n.mu.Lock()
	n.exit, n.output = &exit, truncate(output, aiOutputKeep)
	n.mu.Unlock()
}

// aiOutputKeep is how much of a command's output the record keeps. Enough to
// see what happened; the full answer went to the model.
const aiOutputKeep = 4 << 10

func contentHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

/* ------------------------------------------------------- the wrapper itself */

// aroundAICall records one tool call, start and finish.
//
// The Command Log row appears when the call starts, as it always has; the
// record on it is filled in when the call returns.
func (a *App) aroundAICall(ctx context.Context, tool string, args map[string]any, call mcp.Call) (any, error) {
	caller := mcp.CallerFrom(ctx)
	target, action := aiTarget(tool, args)
	rec := AIRecord{
		ID:          a.aiLog().nextID(),
		At:          time.Now().UnixMilli(),
		HostID:      str(args, "hostId"),
		Client:      caller.Client,
		ClientLabel: a.mcpClientLabel(caller.Client),
		Session:     caller.Session,
		Tool:        tool,
		Kind:        aiKind(tool),
		Target:      target,
		Action:      action,
		Result:      "running",
	}
	seq := a.logAICallRecord(tool, args, rec)
	a.emit("ai:record", rec)

	ctx, note := withAINote(ctx)
	value, err := call(ctx)

	rec.Ended = time.Now().UnixMilli()
	note.mu.Lock()
	rec.Approval, rec.Command = note.approval, note.command
	rec.Snapshot, rec.Created, rec.AfterHash = note.snapshot, note.created, note.afterHash
	rec.Changed = note.changed
	rec.Exit, rec.Output = note.exit, note.output
	note.mu.Unlock()

	switch {
	case err != nil && (rec.Approval == string(outcomeDeclined) || rec.Approval == string(outcomeTimeout)):
		rec.Result = "declined"
	case err != nil:
		rec.Result, rec.Error = "failed", truncate(err.Error(), 500)
	default:
		rec.Result = "ok"
		if m, isMap := value.(map[string]any); isMap {
			if ok, has := m["ok"].(bool); has && !ok {
				rec.Result = "failed"
				if e, _ := m["error"].(string); e != "" {
					rec.Error = truncate(e, 500)
				} else if e, _ := m["stderr"].(string); e != "" {
					rec.Error = truncate(e, 500)
				}
			}
		}
	}

	a.log.finishAI(seq, rec)
	a.aiLog().add(rec)
	a.emit("ai:record", rec)
	return value, err
}

/* ------------------------------------------------------------- the journal */

// aiJournalDays is how far back the graph reaches.
const aiJournalDays = 30

// aiJournalMax bounds the count whatever the age. A month of a busy agent's
// reads is tens of thousands of rows; past this the oldest go first.
const aiJournalMax = 50000

type aiJournal struct {
	path string

	mu   sync.Mutex
	seq  int64
	recs []AIRecord
}

// openAIJournal loads ai-log.jsonl, dropping what has aged out. A line it
// cannot read is skipped rather than costing the rest of the file.
func openAIJournal(dir string) *aiJournal {
	j := &aiJournal{}
	if dir == "" {
		return j
	}
	j.path = filepath.Join(dir, "ai-log.jsonl")
	f, err := os.Open(j.path)
	if err != nil {
		return j
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	read := 0
	for sc.Scan() {
		read++
		var r AIRecord
		if json.Unmarshal(sc.Bytes(), &r) == nil && r.ID != "" {
			j.recs = append(j.recs, r)
		}
	}
	f.Close()
	if j.trim() || len(j.recs) != read {
		_ = j.rewrite()
	}
	return j
}

// aiLog is the journal, or an in-memory one when there is no config directory
// (tests, and a start that could not find one).
func (a *App) aiLog() *aiJournal {
	if a.aiJournal == nil {
		a.aiJournal = openAIJournal("")
	}
	return a.aiJournal
}

func (j *aiJournal) nextID() string {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.seq++
	return strconv.FormatInt(time.Now().UnixMilli(), 36) + "-" + strconv.FormatInt(j.seq, 36)
}

// trim drops records older than the window, and the oldest past the count.
// Reports whether anything went. Caller holds no lock.
func (j *aiJournal) trim() bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	cutoff := time.Now().Add(-aiJournalDays * 24 * time.Hour).UnixMilli()
	before := len(j.recs)
	kept := j.recs[:0]
	for _, r := range j.recs {
		if r.At >= cutoff {
			kept = append(kept, r)
		}
	}
	j.recs = kept
	if len(j.recs) > aiJournalMax {
		j.recs = append([]AIRecord(nil), j.recs[len(j.recs)-aiJournalMax:]...)
	}
	return len(j.recs) != before
}

func (j *aiJournal) add(r AIRecord) {
	j.mu.Lock()
	j.recs = append(j.recs, r)
	// Rewritten rather than appended once in a while, so the file sheds what
	// has aged out without anybody restarting the app.
	compact := len(j.recs) > aiJournalMax+aiJournalMax/10 ||
		(len(j.recs) > 0 && j.recs[0].At < time.Now().Add(-(aiJournalDays+1)*24*time.Hour).UnixMilli())
	path := j.path
	j.mu.Unlock()
	if path == "" {
		if compact {
			j.trim()
		}
		return
	}
	if compact {
		j.trim()
		_ = j.rewrite()
		return
	}
	line, err := json.Marshal(r)
	if err != nil {
		return
	}
	// 0600: a record can carry a command line and the head of its output, and
	// either can hold a secret.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.Write(append(line, '\n'))
	_ = f.Close()
}

func (j *aiJournal) rewrite() error {
	j.mu.Lock()
	var buf []byte
	for _, r := range j.recs {
		line, err := json.Marshal(r)
		if err != nil {
			continue
		}
		buf = append(append(buf, line...), '\n')
	}
	path := j.path
	j.mu.Unlock()
	if path == "" {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".ai-log-*.jsonl")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(buf); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}

func (j *aiJournal) all() []AIRecord {
	j.mu.Lock()
	defer j.mu.Unlock()
	return append([]AIRecord(nil), j.recs...)
}

func (j *aiJournal) get(id string) (AIRecord, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for i := len(j.recs) - 1; i >= 0; i-- {
		if j.recs[i].ID == id {
			return j.recs[i], true
		}
	}
	return AIRecord{}, false
}

// restoredAt reports whether a restore record names this snapshot.
func (j *aiJournal) restored(snapshot string) bool {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, r := range j.recs {
		if r.Kind == aiRestore && r.Restores == snapshot && r.Result == "ok" {
			return true
		}
	}
	return false
}

func (j *aiJournal) bySnapshot(snapshot string) (AIRecord, bool) {
	j.mu.Lock()
	defer j.mu.Unlock()
	for _, r := range j.recs {
		if r.Snapshot == snapshot && r.Kind != aiRestore {
			return r, true
		}
	}
	return AIRecord{}, false
}

/* ------------------------------------------------------------- bindings */

// AIRecords returns the last month of AI work, oldest first.
func (a *App) AIRecords() []AIRecord {
	return a.aiLog().all()
}

// AI change states, as the graph's detail panel shows them.
const (
	// The file is still what the AI wrote: putting it back is safe.
	aiRevertible = "revertible"
	// Something changed the file after this — a later write, a person, a
	// deploy. Putting it back would undo that too.
	aiChanged = "changed"
	// The copy aged out of the retention window.
	aiExpired = "expired"
	// Somebody already put it back.
	aiRestored = "restored"
	// The file was too large to copy, or the copy could not be made.
	aiNoCopy = "nocopy"
	// The host is not connected, so the file cannot be compared.
	aiOffline = "offline"
	// Not a file: a restart, a signal, a command. Nothing to put back.
	aiIrreversible = "irreversible"
	// The change never happened — declined, or failed.
	aiNotApplied = "notapplied"
)

// AIChangeView is one record's detail: whether it can be put back, and the
// change itself.
type AIChangeView struct {
	State   string `json:"state"`
	Path    string `json:"path,omitempty"`
	Before  string `json:"before,omitempty"`
	After   string `json:"after,omitempty"`
	HasDiff bool   `json:"hasDiff"`
	Created bool   `json:"created,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
	Error   string `json:"error,omitempty"`
}

// AIChange works out whether one recorded change can be put back, by comparing
// the file on the server with what the AI wrote.
func (a *App) AIChange(id string) AIChangeView {
	rec, ok := a.aiLog().get(id)
	if !ok {
		return AIChangeView{State: aiNotApplied, Error: i18n.S("기록을 찾을 수 없습니다")}
	}
	return a.aiChange(rec, true)
}

func (a *App) aiChange(rec AIRecord, check bool) AIChangeView {
	out := AIChangeView{Path: rec.Target, Created: rec.Created, Deleted: rec.Kind == aiFileDelete}
	if rec.Kind != aiFileWrite && rec.Kind != aiFileDelete {
		out.State = aiIrreversible
		return out
	}
	if rec.Result != "ok" || !rec.Changed {
		out.State = aiNotApplied
		return out
	}
	if rec.Snapshot == "" || a.rollback == nil {
		out.State = aiNoCopy
		return out
	}
	entry, found := a.rollback.Get(rec.Snapshot)
	if !found {
		out.State = aiExpired
		return out
	}
	out.Path = entry.Path
	if before, err := a.rollback.Contents(rec.Snapshot); err == nil {
		out.Before = string(before)
	}
	if after, has := a.rollback.After(rec.Snapshot); has {
		out.After, out.HasDiff = string(after), true
	} else if out.Deleted {
		out.HasDiff = true
	}
	switch {
	case entry.Restored || a.aiLog().restored(rec.Snapshot):
		out.State = aiRestored
		return out
	case !entry.Undoable():
		out.State = aiNoCopy
		return out
	case !check:
		out.State = aiRevertible
		return out
	}

	cur, err := a.ReadTextFile(entry.HostID, entry.Path)
	missing := err != nil && errors.Is(err, os.ErrNotExist)
	switch {
	case err != nil && errors.Is(err, sshcore.ErrNotConnected):
		out.State = aiOffline
	case err != nil && !missing:
		out.State, out.Error = aiOffline, err.Error()
	case out.Deleted:
		// Still gone is what the AI left. Back again means somebody made it.
		if missing {
			out.State = aiRevertible
		} else {
			out.State = aiChanged
		}
	case missing || cur.TooLarge || cur.Binary:
		out.State = aiChanged
	case contentHash([]byte(cur.Content)) == rec.AfterHash:
		out.State = aiRevertible
	default:
		out.State = aiChanged
	}
	return out
}

// AIRevert puts one change back. A file something else has changed since is
// refused unless force is set — the panel asks the person first, because
// putting it back would also undo that later change.
func (a *App) AIRevert(id string, force bool) ActionResult {
	rec, ok := a.aiLog().get(id)
	if !ok {
		return failResult(i18n.Errorf("기록을 찾을 수 없습니다"))
	}
	view := a.aiChange(rec, true)
	switch {
	case view.State == aiRevertible, view.State == aiChanged && force:
		return a.RestoreMCPChange(rec.Snapshot)
	case view.State == aiChanged:
		return failResult(i18n.Errorf("이 파일은 그 뒤에 다시 바뀌었습니다"))
	case view.State == aiOffline:
		return failResult(i18n.Errorf("연결해야 서버의 파일과 비교할 수 있습니다"))
	}
	return failResult(i18n.Errorf("되돌릴 수 없는 항목입니다"))
}

// AIRevertSkip is a file a session revert left alone, and why.
type AIRevertSkip struct {
	Path   string `json:"path"`
	HostID string `json:"hostId"`
	// Reason is one of the change states, or "failed" with Error set.
	Reason string `json:"reason"`
	Error  string `json:"error,omitempty"`
}

// AIRevertReport is what a session revert did.
type AIRevertReport struct {
	Reverted []string       `json:"reverted"`
	Skipped  []AIRevertSkip `json:"skipped"`
	// Irreversible counts the session's restarts, signals and commands —
	// things a file revert does not touch and cannot.
	Irreversible int `json:"irreversible"`
}

// AIRevertSession puts back every file a session changed, newest first.
//
// Newest first is what makes a chain work: three writes to one file are undone
// third, second, first, and each step finds the file holding exactly what the
// step before it wrote. A file something else changed is skipped — and so is
// every earlier change to it, since the chain under it is broken — and listed,
// so the person can decide.
func (a *App) AIRevertSession(session string) AIRevertReport {
	report := AIRevertReport{Reverted: []string{}, Skipped: []AIRevertSkip{}}
	if session == "" {
		return report
	}
	var recs []AIRecord
	for _, r := range a.aiLog().all() {
		if r.Session != session || r.Kind == aiRestore {
			continue
		}
		switch r.Kind {
		case aiService, aiProcess, aiContainer, aiCommand:
			if r.Result == "ok" {
				report.Irreversible++
			}
		case aiFileWrite, aiFileDelete:
			if r.Result == "ok" {
				recs = append(recs, r)
			}
		}
	}
	sort.SliceStable(recs, func(i, j int) bool { return recs[i].At > recs[j].At })

	broken := map[string]bool{}
	for _, r := range recs {
		key := r.HostID + "\x00" + r.Target
		if broken[key] {
			report.Skipped = append(report.Skipped, AIRevertSkip{Path: r.Target, HostID: r.HostID, Reason: aiChanged})
			continue
		}
		view := a.aiChange(r, true)
		switch view.State {
		case aiRestored:
			continue
		case aiRevertible:
			if res := a.RestoreMCPChange(r.Snapshot); res.OK {
				report.Reverted = append(report.Reverted, view.Path)
				continue
			} else {
				report.Skipped = append(report.Skipped, AIRevertSkip{
					Path: view.Path, HostID: r.HostID, Reason: "failed", Error: res.Error})
			}
		default:
			report.Skipped = append(report.Skipped, AIRevertSkip{
				Path: r.Target, HostID: r.HostID, Reason: view.State, Error: view.Error})
		}
		broken[key] = true
	}
	return report
}

// recordRestore notes that a person put a change back.
func (a *App) recordRestore(snapshot, hostID, path string, err error) {
	rec := AIRecord{
		ID:       a.aiLog().nextID(),
		At:       time.Now().UnixMilli(),
		HostID:   hostID,
		Tool:     "restore",
		Kind:     aiRestore,
		Target:   path,
		Restores: snapshot,
		Result:   "ok",
	}
	if orig, ok := a.aiLog().bySnapshot(snapshot); ok {
		rec.Session = orig.Session
	}
	if err != nil {
		rec.Result, rec.Error = "failed", err.Error()
	}
	rec.Ended = rec.At
	a.aiLog().add(rec)
	a.emit("ai:record", rec)
}
