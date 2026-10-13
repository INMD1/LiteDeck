package adapter

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The layouts below are built from NVIDIA's Jetson Linux documentation and the
// jetson-stats source, not captured from a board: devfreq under
// /sys/class/devfreq linking to the GPU's platform device, `load` in per mille
// on the device, clocks in Hz, device-tree strings NUL-terminated. A capture
// from a real Orin should replace them when one is available.

// runTegraSection runs the real script against a fake root. The paths are
// rewritten here, in the test, so the script under test stays the constant
// that ships.
func runTegraSection(t *testing.T, root string) []string {
	t.Helper()
	script := tegraSection
	for _, p := range []string{"/etc/", "/proc/", "/sys/"} {
		script = strings.ReplaceAll(script, p, root+p)
	}
	out, err := exec.Command("sh", "-c", script).CombinedOutput()
	if err != nil {
		t.Fatalf("script failed: %v\n%s", err, out)
	}
	return splitSections(out)["tegra"]
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func link(t *testing.T, target, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
}

// devfreqDevice lays out one devfreq device the way the kernel does: the
// class entry is a link into the device's own devfreq directory, whose
// `device` link points back up at the device.
func devfreqDevice(t *testing.T, root, name, node, load, cur, max string) {
	dev := filepath.Join(root, "sys/devices/platform", name)
	df := filepath.Join(dev, "devfreq", name)
	write(t, filepath.Join(dev, "of_node/name"), node+"\x00")
	if load != "" {
		write(t, filepath.Join(dev, "load"), load+"\n")
	}
	write(t, filepath.Join(df, "cur_freq"), cur+"\n")
	write(t, filepath.Join(df, "max_freq"), max+"\n")
	link(t, "../..", filepath.Join(df, "device"))
	link(t, df, filepath.Join(root, "sys/class/devfreq", name))
}

func thermalZone(t *testing.T, root string, n int, typ, temp string) {
	z := filepath.Join(root, "sys/class/thermal", "thermal_zone"+string(rune('0'+n)))
	write(t, filepath.Join(z, "type"), typ+"\n")
	if temp != "" {
		write(t, filepath.Join(z, "temp"), temp+"\n")
	}
}

func TestTegraSectionReadsAnOrin(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "etc/nv_tegra_release"), "# R36 (release), REVISION: 4.3\n")
	write(t, filepath.Join(root, "proc/device-tree/model"), "NVIDIA Jetson AGX Orin Developer Kit\x00")
	devfreqDevice(t, root, "17000000.gpu", "gpu", "347", "612000000", "1300500000")
	// Other engines have devfreq too. A VIC with no load file is skipped by
	// the script; one with a load file is skipped by name.
	devfreqDevice(t, root, "15340000.vic", "vic", "", "115200000", "729600000")
	devfreqDevice(t, root, "15480000.nvdec", "nvdec", "120", "115200000", "729600000")
	thermalZone(t, root, 0, "cpu-thermal", "41250")
	thermalZone(t, root, 1, "gpu-thermal", "39875")

	r := parseTegra(runTegraSection(t, root))
	if !r.Jetson {
		t.Fatal("not recognised as a Jetson")
	}
	if len(r.GPUs) != 1 {
		t.Fatalf("GPUs = %+v, want one", r.GPUs)
	}
	g := r.GPUs[0]
	if g.Name != "Jetson AGX Orin Developer Kit" {
		t.Errorf("name = %q — the NUL or the vendor prefix survived", g.Name)
	}
	if g.Utilization != 34.7 {
		t.Errorf("utilization = %v, want 34.7 (load is per mille)", g.Utilization)
	}
	if g.ClockMHz != 612 || g.MaxClockMHz != 1300 {
		t.Errorf("clock = %d / %d MHz, want 612 / 1300", g.ClockMHz, g.MaxClockMHz)
	}
	if g.TempC != 39.875 {
		t.Errorf("temp = %v, want the gpu zone's 39.875", g.TempC)
	}
	if !g.Shared || g.Fan != -1 {
		t.Errorf("shared = %v, fan = %v", g.Shared, g.Fan)
	}
}

// A Jetson whose GPU devfreq has no load file — Thor — is still a Jetson, so
// its nvidia-smi rows learn that the memory is shared.
func TestTegraSectionOnThorFindsNoDevfreqGPU(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "etc/nv_tegra_release"), "# R38 (release), REVISION: 2.1\n")
	write(t, filepath.Join(root, "proc/device-tree/model"), "NVIDIA Jetson AGX Thor Developer Kit\x00")
	devfreqDevice(t, root, "gpu-gpc-0", "gpu-gpc-0", "", "1575000000", "1575000000")
	thermalZone(t, root, 0, "gpu-thermal", "52000")

	r := parseTegra(runTegraSection(t, root))
	if !r.Jetson || len(r.GPUs) != 0 {
		t.Fatalf("jetson = %v, GPUs = %+v; want a Jetson with no devfreq GPU", r.Jetson, r.GPUs)
	}
	got := r.Apply([]GPU{{Index: 0, Name: "NVIDIA Thor", Utilization: 18, Fan: -1, TempC: -1}})
	if len(got) != 1 || !got[0].Shared || got[0].TempC != 52 || got[0].Utilization != 18 {
		t.Errorf("Thor row = %+v; want nvidia-smi's utilisation, shared memory, the zone's temperature", got)
	}
}

// Every other server: one builtin test and an empty section.
func TestTegraSectionIsSilentOffAJetson(t *testing.T) {
	root := t.TempDir()
	devfreqDevice(t, root, "fde60000.gpu", "gpu", "500", "800000000", "800000000")
	lines := runTegraSection(t, root)
	if len(lines) != 0 {
		t.Errorf("printed %q on a host without nv_tegra_release", lines)
	}
	r := parseTegra(lines)
	in := []GPU{{Index: 0, Name: "NVIDIA A100", Utilization: 50, MemTotal: 1 << 30}}
	if got := r.Apply(in); len(got) != 1 || got[0] != in[0] {
		t.Errorf("Apply changed a non-Jetson card: %+v", got)
	}
}

// JetPack 6's nvidia-smi names the Orin and says nothing else. That row would
// be a GPU panel with nothing in it beside the real reading.
func TestApplyDropsTheNvgpuStubButKeepsADiscreteCard(t *testing.T) {
	r := TegraReading{
		Jetson: true,
		TempC:  -1,
		GPUs:   []GPU{{Name: "Jetson AGX Orin", Utilization: 12, Fan: -1, TempC: -1, Shared: true}},
	}
	stub := GPU{Index: 0, Name: "Orin (nvgpu)", Utilization: -1, Fan: -1, TempC: -1}
	if got := r.Apply([]GPU{stub}); len(got) != 1 || got[0].Name != "Jetson AGX Orin" || got[0].Index != 0 {
		t.Errorf("with the stub: %+v; want only the devfreq GPU, as card 0", got)
	}

	// An IGX with a discrete card: nvidia-smi's to report, and numbered first.
	dgpu := GPU{Index: 0, Name: "NVIDIA RTX A6000", Utilization: 40, Fan: 30, TempC: 60, MemTotal: 48 << 30}
	got := r.Apply([]GPU{dgpu})
	if len(got) != 2 || got[0].Name != dgpu.Name || got[1].Index != 1 {
		t.Errorf("with a discrete card: %+v; want it kept as 0 and the Orin as 1", got)
	}
}

// The script is a compile-time constant on both poll paths.
func TestBothMetricsScriptsCarryTheTegraSection(t *testing.T) {
	for name, s := range map[string]string{"MetricsScript": MetricsScript, "MetricsScriptWithGPU": MetricsScriptWithGPU} {
		if !strings.Contains(s, "echo '#tegra'") {
			t.Errorf("%s has no #tegra section", name)
		}
		if !strings.HasSuffix(s, "\n:") {
			t.Errorf("%s no longer ends in the `:` that keeps its exit status its own", name)
		}
	}
}
