package sshcore

import (
	"bytes"
	"regexp"
)

// Asking a live terminal where it is (§4.6a).
//
// `code .` and `vi foo.cpp` are handled by the app, not by the server: the
// keystrokes are caught before they are sent, so no command runs remotely and
// nothing has to exist there. That is what makes the feature work on a Windows
// box with neither VS Code nor vi on it, and on any shell at all.
//
// It leaves exactly one thing the client cannot know. `.` and `src/main.go` are
// relative to wherever that shell is standing, and only the shell knows. So it
// is asked — once, at the moment somebody types such a path, and never at
// session start. Nothing is defined, exported or installed; a shell that is
// never asked is never touched.
//
// An earlier design defined functions in the session instead. It broke a
// Windows terminal outright (cmd.exe cannot read POSIX) and an Alpine one
// (`export -f` aborts dash), and it could not work on zsh at all. Asking a
// question is portable in a way that installing a vocabulary is not.

// cwdProbe is the question, per shell family. The reply is swallowed before it
// reaches the screen, so the user sees their prompt and nothing else.
type cwdProbe struct {
	command  string
	response *regexp.Regexp
}

var (
	// POSIX. $PWD needs no subshell and no external binary, so this works on
	// bash, zsh, ash and dash alike.
	posixCWD = cwdProbe{
		command:  `printf 'LDCWD:%s:END\n' "$PWD"`,
		response: regexp.MustCompile(`LDCWD:(.+?):END`),
	}
	// cmd.exe. `%cd%` is the shell's own idea of where it is.
	cmdCWD = cwdProbe{
		command:  `echo LDCWD:%cd%:END`,
		response: regexp.MustCompile(`LDCWD:(.+?):END`),
	}
	// PowerShell. Given cmd's question it printed `LDCWD:%cd%:END` back as
	// text, so `vi` in a PowerShell pane waited three seconds and failed with
	// the question left on screen. The markers are built from pieces so the
	// echoed command does not contain them — only the answer does — and
	// ProviderPath is `C:\Users\…` rather than PowerShell's own
	// `Microsoft.PowerShell.Core\FileSystem::` spelling.
	psCWD = cwdProbe{
		command:  `Write-Output ('LDC'+'WD:'+$PWD.ProviderPath+':E'+'ND')`,
		response: regexp.MustCompile(`LDCWD:(.+?):END`),
	}
)

// probeFor picks the question for a terminal's shell.
func probeFor(windows bool, kind string) cwdProbe {
	switch {
	case !windows || kind == "posix":
		return posixCWD
	case kind == "powershell":
		return psCWD
	}
	return cmdCWD
}

// parseCWD pulls the answer out of everything the shell said.
//
// The echo of the question contains the marker too — `%s` on POSIX, `%cd%` on
// cmd — so the *last* match is the answer and the first is the question coming
// back. Matching the last one is simpler than trying to make the question
// unrecognisable, and it does not depend on how the shell echoes.
func parseCWD(out []byte, p cwdProbe) string {
	dir, _ := parseCWDAt(out, p)
	return dir
}

// parseCWDAt is parseCWD that also says where the answer's line ends, so what
// the shell printed after it — its next prompt — can go to the screen.
func parseCWDAt(out []byte, p cwdProbe) (string, int) {
	all := p.response.FindAllSubmatchIndex(out, -1)
	for i := len(all) - 1; i >= 0; i-- {
		m := all[i]
		got := bytes.TrimSpace(out[m[2]:m[3]])
		// The echoed question still holds its own placeholder.
		if bytes.ContainsAny(got, "%") {
			continue
		}
		if len(got) > 0 {
			end := m[1]
			// The answer's own line break belongs to the answer.
			for end < len(out) && (out[end] == '\r' || out[end] == '\n') {
				end++
			}
			return string(got), end
		}
	}
	return "", 0
}
