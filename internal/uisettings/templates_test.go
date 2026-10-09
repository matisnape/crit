package uisettings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCRIT06_1_TemplatesAreAStoredSetting(t *testing.T) {
	if !IsSetting("templates") {
		t.Fatal("templates is not a stored setting")
	}
	for _, v := range []any{[]any{}, []any{"Fix typo", "LGTM"}} {
		if err := Validate("templates", v); err != nil {
			t.Errorf("%v rejected: %v", v, err)
		}
	}
	path := settingsFile(t)
	if _, err := Save(map[string]any{"templates": []any{"Fix typo"}}, false); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != "{\n  \"templates\": [\n    \"Fix typo\"\n  ]\n}\n" {
		t.Fatalf("file = %s", data)
	}
}

func TestCRIT06_4_InvalidTemplatesFallBackAloneToNone(t *testing.T) {
	for _, v := range []any{"[\"Fix typo\"", map[string]any{"a": "b"}, []any{1}, []any{"ok", nil}} {
		if err := Validate("templates", v); err == nil {
			t.Errorf("%v accepted", v)
		}
	}
	path := settingsFile(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"theme":"dark","templates":"[\"Fix typo\""}`), 0o644); err != nil {
		t.Fatal(err)
	}
	snap, problem := Load()
	if _, ok := snap.Settings["templates"]; ok || snap.Settings["theme"] != "dark" || problem == "" {
		t.Fatalf("settings = %v, problem = %q", snap.Settings, problem)
	}
}
