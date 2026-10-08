package testutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCRIT02_13_GuardRealUISettingsDetectsAnyChange(t *testing.T) {
	cases := map[string]func(path string){
		"created": func(path string) { WriteFile(t, path, `{"theme":"dark"}`) },
		"changed": func(path string) { WriteFile(t, path, `{"theme":"light"}`) },
		"removed": func(path string) { os.Remove(path) },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			SetHome(t, home)
			path := filepath.Join(home, ".crit", "ui-settings.json")
			if name != "created" {
				WriteFile(t, path, `{"theme":"dark"}`)
			}
			unchanged := GuardRealUISettings()
			if err := unchanged(); err != nil {
				t.Fatalf("untouched file reported as changed: %v", err)
			}
			mutate(path)
			if err := unchanged(); err == nil {
				t.Fatalf("%s file not reported", name)
			}
		})
	}
}
