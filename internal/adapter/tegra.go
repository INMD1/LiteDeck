package adapter

import (
	"strconv"
	"strings"
)

// The Jetson GPU.
//
// # Why not nvidia-smi
//
// A Jetson's GPU sits on the memory controller rather than the PCI bus, and
// up to JetPack 6 it is driven by nvgpu rather than the driver NVML talks to.
// JetPack 5 has no nvidia-smi at all. JetPack 6 has one, and on an Orin it
// answers with a card called "Orin (nvgpu)" and "[N/A]" in every other column
// — a row that would put a GPU panel on screen with nothing in it.
//
// # What is read instead
//
// The kernel's own devfreq entry for the GPU, the way jetson-stats does it:
// every /sys/class/devfreq device whose device-tree node is a known Tegra GPU
// and which has a `load` file. `load` is per mille of the last window spent
// busy; devfreq has the clock beside it. Matching on the node name rather than
// a path is what survives the path changing between releases —
// 17000000.ga10b on JetPack 5, 17000000.gpu on JetPack 6, gpu.0 on a Nano.
//
// # Thor
//
// JetPack 7 boards drive the GPU with the same open driver as a server, so
// nvidia-smi answers there and tegrastats reads 0%. Thor's devfreq domains have
// no `load` file, so nothing here claims it and the nvidia-smi rows stand. What
// this still adds is the two things nvidia-smi cannot say on it: the memory is
// shared, and the GPU's temperature from its thermal zone.
//
// # Not tegrastats
//
// It runs until killed, its line changes shape across releases, and without
// root it leaves fields out. Three files read inside the round trip the summary
// bar already makes cost none of that.

// tegraSection reads the Jetson GPU. One builtin test on every other host.
//
// v prints key=value with the value as the kernel wrote it. device-tree
// strings end in a NUL rather than a newline, and a $(cat) would make bash
// complain about that on stderr, so the value goes straight to stdout and the
// parser trims it. A file that could not be read leaves an empty value rather
// than shifting the next one onto its line.
//
// The thermal zones are found with one grep rather than read one by one: an
// Orin has a dozen, and some of them answer EAGAIN while the GPU is gated.
const tegraSection = `echo '#tegra'; if [ -f /etc/nv_tegra_release ]; then
v() { printf '%s=' "$1"; cat "$2" 2>/dev/null; echo; }
echo l4t; v model /proc/device-tree/model
for d in /sys/class/devfreq/*; do [ -r "$d/device/load" ] || continue; v node "$d/device/of_node/name"; v load "$d/device/load"; v cur "$d/cur_freq"; v max "$d/max_freq"; done
for t in $(grep -il '^gpu' /sys/class/thermal/thermal_zone*/type 2>/dev/null); do v temp "${t%/type}/temp"; done
fi`

// tegraGPUNodes are the device-tree node names of Tegra GPUs, as jetson-stats
// recognises them: Xavier, TX2, Orin, Thor, and the plain "gpu" that the Nano
// and JetPack 6 use.
var tegraGPUNodes = map[string]bool{
	"gv11b": true, "gp10b": true, "ga10b": true, "gb10b": true, "gpu": true,
}

// TegraReading is the #tegra section.
type TegraReading struct {
	// Jetson is true on any L4T host, whether or not its GPU was readable.
	Jetson bool
	// GPUs are the GPUs devfreq answered for. Empty on Thor, and on a Jetson
	// whose sysfs this account cannot read.
	GPUs []GPU
	// TempC is the GPU thermal zone, -1 where there is none or it would not
	// answer.
	TempC float64
}

func parseTegra(lines []string) TegraReading {
	r := TegraReading{TempC: -1}
	model := ""
	type dev struct {
		node         string
		load         float64
		cur, max     int64
		loadReadable bool
	}
	var devs []dev
	for _, line := range lines {
		line = strings.TrimSpace(strings.ReplaceAll(line, "\x00", ""))
		if line == "l4t" {
			r.Jetson = true
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		val = strings.TrimSpace(val)
		switch key {
		case "model":
			model = val
		case "node":
			devs = append(devs, dev{node: val})
		case "load", "cur", "max":
			if len(devs) == 0 {
				continue
			}
			d := &devs[len(devs)-1]
			n, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				continue
			}
			switch key {
			case "load":
				d.load, d.loadReadable = float64(n)/10, true
			case "cur":
				d.cur = n
			case "max":
				d.max = n
			}
		case "temp":
			// Millidegrees. The first zone that answers; an Orin has one.
			if n, err := strconv.ParseInt(val, 10, 64); err == nil && r.TempC < 0 {
				r.TempC = float64(n) / 1000
			}
		}
	}
	if !r.Jetson {
		return TegraReading{TempC: -1}
	}

	name := strings.TrimSpace(strings.TrimPrefix(model, "NVIDIA "))
	for _, d := range devs {
		if !tegraGPUNodes[d.node] || !d.loadReadable {
			continue
		}
		g := GPU{
			Name:        name,
			Utilization: clampPercent(d.load),
			Fan:         -1,
			TempC:       r.TempC,
			Shared:      true,
			// devfreq counts in Hz.
			ClockMHz:    int(d.cur / 1_000_000),
			MaxClockMHz: int(d.max / 1_000_000),
		}
		if g.Name == "" {
			g.Name = "Tegra " + d.node
		}
		r.GPUs = append(r.GPUs, g)
	}
	return r
}

// Apply lays the Jetson reading over the card list nvidia-smi produced, by
// whichever route — the inline query or the feed.
//
// Off a Jetson it changes nothing. On one whose GPU devfreq answered, the
// nvidia-smi rows that say nothing at all are dropped — that is the nvgpu stub
// — and the devfreq GPU takes their place. A row with a real figure in it is
// kept: an IGX board can carry a discrete card beside the Orin, and that card
// is nvidia-smi's to report. Where devfreq did not answer (Thor), the rows stand
// and gain what nvidia-smi leaves out there.
func (t TegraReading) Apply(gpus []GPU) []GPU {
	if !t.Jetson {
		return gpus
	}
	if len(t.GPUs) == 0 {
		out := make([]GPU, len(gpus))
		for i, g := range gpus {
			g.Shared = g.MemTotal <= 0
			if g.TempC < 0 {
				g.TempC = t.TempC
			}
			out[i] = g
		}
		return out
	}
	out := []GPU{}
	for _, g := range gpus {
		if g.Utilization < 0 && g.TempC < 0 && g.MemTotal <= 0 {
			continue
		}
		out = append(out, g)
	}
	// After the discrete cards and numbered on from them: the UI keys each
	// card's history by its index, and two cards both called 0 would share one.
	next := 0
	for _, g := range out {
		next = max(next, g.Index+1)
	}
	for i, g := range t.GPUs {
		g.Index = next + i
		out = append(out, g)
	}
	return out
}
