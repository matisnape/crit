// Package uisettings owns ~/.crit/ui-settings.json: the Settings-dialog
// choices (theme, palettes, code display, shortcuts) shared by every review
// on the machine. Browser storage is scoped to a host (and port), so only a
// file the crit server owns reaches every review. It is global-only: project
// config never reads or writes it. Per-review state (panel widths, collapsed
// files, drafts) stays in the browser.
package uisettings

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	webassets "github.com/tomasz-tomczyk/crit/web"
)

// Snapshot is the stored settings as served to the page.
type Snapshot struct {
	Exists   bool           `json:"exists"`
	Path     string         `json:"path"`
	Settings map[string]any `json:"settings"`
}

var enums = map[string][]string{
	"theme":            {"system", "light", "dark"},
	"lineNumbers":      {"on", "off"},
	"boostContrast":    {"off", "on"},
	"codeOverflow":     {"scroll", "wrap"},
	"inlineDiff":       {"word-alt", "word", "char", "none"},
	"changeIndicators": {"bars", "classic", "none"},
	"unchangedContext": {"collapsed", "expanded"},
	"width":            {"compact", "default", "wide"},
}

var bools = map[string]bool{"hideResolved": true, "ignoreWhitespace": true, "live_hideResolved": true}

// Mirrors MAX_CODE_FONT_LENGTH in web/crit-shared.js.
const maxCodeFontLength = 256

// IsSetting reports whether key is a Settings-dialog control stored here.
func IsSetting(key string) bool {
	_, enum := enums[key]
	return enum || bools[key] || key == "lightPalette" || key == "darkPalette" || key == "codeFont" || key == "shortcuts" || key == "templates"
}

// Validate reports why value is not acceptable for key, or nil.
func Validate(key string, value any) error {
	switch {
	case enums[key] != nil:
		return validateEnum(key, value)
	case bools[key]:
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("%s: %s is not true or false", key, describe(value))
		}
		return nil
	case key == "lightPalette" || key == "darkPalette":
		return validatePalette(key, value)
	case key == "codeFont":
		if s, ok := value.(string); !ok || len(s) > maxCodeFontLength {
			return fmt.Errorf("codeFont: %s is not a font-family list of at most %d characters", describe(value), maxCodeFontLength)
		}
		return nil
	case key == "shortcuts":
		return validateShortcuts(value)
	case key == "templates":
		return validateTemplates(value)
	}
	return fmt.Errorf("%s: unknown setting", key)
}

func validateEnum(key string, value any) error {
	s, _ := value.(string)
	for _, ok := range enums[key] {
		if s == ok {
			return nil
		}
	}
	return fmt.Errorf("%s: %s is not one of %s", key, describe(value), strings.Join(enums[key], ", "))
}

func validatePalette(key string, value any) error {
	mode := strings.TrimSuffix(key, "Palette")
	if s, _ := value.(string); paletteTypes()[s] != mode {
		return fmt.Errorf("%s: %s is not a known %s theme", key, describe(value), mode)
	}
	return nil
}

func validateShortcuts(value any) error {
	m, ok := value.(map[string]any)
	if !ok {
		return fmt.Errorf("shortcuts: %s is not an object", describe(value))
	}
	for id, b := range m {
		if _, ok := b.(string); !ok {
			return fmt.Errorf("shortcuts.%s: %s is not a key binding", id, describe(b))
		}
	}
	return nil
}

// validateTemplates accepts the saved comment templates: a list of strings.
func validateTemplates(value any) error {
	list, ok := value.([]any)
	if !ok {
		return fmt.Errorf("templates: %s is not a list", describe(value))
	}
	for _, t := range list {
		if _, ok := t.(string); !ok {
			return fmt.Errorf("templates: %s is not a template text", describe(t))
		}
	}
	return nil
}

func describe(v any) string {
	b, _ := json.Marshal(v)
	if len(b) > 60 {
		b = append(b[:57], "..."...)
	}
	return string(b)
}

// paletteTypes maps each bundled palette id to "light" or "dark", read from
// the same pierre/palettes.js the page loads.
var paletteTypes = sync.OnceValue(func() map[string]string {
	out := map[string]string{}
	f, err := webassets.FS.Open("pierre/palettes.js.gz")
	if err != nil {
		return out
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return out
	}
	src, _ := io.ReadAll(zr)
	start, end := bytes.IndexByte(src, '['), bytes.LastIndexByte(src, ']')
	if start < 0 || end < start {
		return out
	}
	var list []struct{ ID, Type string }
	if json.Unmarshal(src[start:end+1], &list) == nil {
		for _, p := range list {
			out[p.ID] = p.Type
		}
	}
	return out
})

// Path returns ~/.crit/ui-settings.json, resolved on every call so a test's
// temp HOME takes effect.
func Path() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("finding home directory: %w", err)
	}
	return filepath.Join(home, ".crit", "ui-settings.json"), nil
}

// Load reads the file. Unreadable JSON, unknown keys and invalid values are
// dropped (each falls back to its default) and described in problem, which is
// "" for a clean file. Load never writes.
func Load() (snap Snapshot, problem string) {
	path, err := Path()
	snap = Snapshot{Path: path, Settings: map[string]any{}}
	if err != nil {
		return snap, err.Error()
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return snap, ""
	}
	snap.Exists = true
	if err != nil {
		return snap, err.Error()
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return snap, "invalid JSON: " + err.Error()
	}
	var problems []string
	for k, v := range raw {
		if err := Validate(k, v); err != nil {
			problems = append(problems, err.Error())
			continue
		}
		snap.Settings[k] = v
	}
	sort.Strings(problems)
	return snap, strings.Join(problems, "; ")
}

// WarnIfInvalid prints one line naming the file and its problems, if any.
func WarnIfInvalid(w io.Writer) {
	if snap, problem := Load(); problem != "" {
		fmt.Fprintf(w, "Warning: ignoring invalid parts of %s (using defaults for them): %s\n", snap.Path, problem)
	}
}

// ponytail: one in-process lock. Two daemons saving within the same few
// milliseconds can still lose one change; add a lock file if that shows up.
var mu sync.Mutex

// Save merges changes into the current file (a nil value removes the key, so
// it falls back to its default) and writes it atomically. Only the sent keys
// change, so a tab holding stale values cannot revert another tab's choice.
// With ifAbsent, nothing is written when the file already exists.
func Save(changes map[string]any, ifAbsent bool) (Snapshot, error) {
	for k, v := range changes {
		if v == nil {
			continue
		}
		if err := Validate(k, v); err != nil {
			return Snapshot{}, err
		}
	}
	mu.Lock()
	defer mu.Unlock()
	snap, _ := Load()
	if snap.Path == "" || (ifAbsent && snap.Exists) {
		return snap, nil
	}
	for k, v := range changes {
		if v == nil {
			delete(snap.Settings, k)
		} else {
			snap.Settings[k] = v
		}
	}
	if err := writeAtomic(snap.Path, snap.Settings); err != nil {
		return snap, fmt.Errorf("could not save settings to %s: %w", snap.Path, err)
	}
	snap.Exists = true
	return snap, nil
}

// Reset removes the file, so every setting falls back to its default.
func Reset() error {
	path, err := Path()
	if err != nil {
		return err
	}
	mu.Lock()
	defer mu.Unlock()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("could not remove %s: %w", path, err)
	}
	return nil
}

// rename is os.Rename; tests swap it to exercise the temp-file cleanup.
var rename = os.Rename

func writeAtomic(path string, settings map[string]any) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	// rename(2) replaces a read-only file without complaint; a read-only file
	// is the user saying "leave my settings alone", so honour it.
	if f, err := os.OpenFile(path, os.O_WRONLY, 0); err == nil {
		f.Close()
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".ui-settings-*.tmp")
	if err != nil {
		return err
	}
	_, err = tmp.Write(data)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}
