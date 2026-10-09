package server

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// templatesCookie encodes like web/crit-shared.js setCookie (encodeURIComponent).
func templatesCookie(list []string) string {
	b, _ := json.Marshal(list)
	return "crit-templates=" + strings.ReplaceAll(url.QueryEscape(string(b)), "+", "%20")
}

func storedSettings(t *testing.T, path string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestCRIT06_2_FirstPageLoadImportsTemplatesCookie(t *testing.T) {
	path := uiSettingsHome(t)
	s, _ := newTestServer(t)
	both := cookieHeader(map[string]any{"theme": "light"})["Cookie"] + "; " + templatesCookie([]string{"Fix typo", "Needs a test"})
	snap := injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", map[string]string{"Cookie": both}).Body.String())
	want := []any{"Fix typo", "Needs a test"}
	if got := snap["settings"].(map[string]any); !reflect.DeepEqual(got["templates"], want) || got["theme"] != "light" {
		t.Fatalf("injected = %v", got)
	}
	if got := storedSettings(t, path); !reflect.DeepEqual(got["templates"], want) || got["theme"] != "light" {
		t.Fatalf("stored = %v", got)
	}
	before, _ := os.ReadFile(path)

	// Afterwards another host's cookie does not overwrite the file.
	other := map[string]string{"Cookie": templatesCookie([]string{"From another host"})}
	snap = injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", other).Body.String())
	if got := snap["settings"].(map[string]any)["templates"]; !reflect.DeepEqual(got, want) {
		t.Fatalf("second cookie applied: %v", got)
	}
	if after, _ := os.ReadFile(path); string(after) != string(before) {
		t.Fatalf("file rewritten:\n%s", after)
	}
}

func TestCRIT06_2_ImportsIntoAFileThatHoldsOtherSettings(t *testing.T) {
	path := uiSettingsHome(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"theme":"dark"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServer(t)
	serve(t, s, http.MethodGet, "/", "", map[string]string{"Cookie": templatesCookie([]string{"LGTM"})})
	if got := storedSettings(t, path); !reflect.DeepEqual(got, map[string]any{"theme": "dark", "templates": []any{"LGTM"}}) {
		t.Fatalf("stored = %v", got)
	}
}

func TestCRIT06_3_DeletedTemplatesAreNotReimportedFromACookie(t *testing.T) {
	path := uiSettingsHome(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"templates":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServer(t)
	snap := injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", map[string]string{"Cookie": templatesCookie([]string{"Deleted"})}).Body.String())
	if got := snap["settings"].(map[string]any)["templates"]; !reflect.DeepEqual(got, []any{}) {
		t.Fatalf("injected templates = %v", got)
	}
	if got := storedSettings(t, path); !reflect.DeepEqual(got, map[string]any{"templates": []any{}}) {
		t.Fatalf("stored = %v", got)
	}
}

func TestCRIT06_4_PageLoadDoesNotRewriteAnUnreadableFile(t *testing.T) {
	path := uiSettingsHome(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, body := range []string{`{"theme":"dark",`, `{"theme":"dark","templates":"[\"Fix typo\""}`} {
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		s, _ := newTestServer(t)
		serve(t, s, http.MethodGet, "/", "", map[string]string{"Cookie": templatesCookie([]string{"LGTM"})})
		if after, _ := os.ReadFile(path); string(after) != body {
			t.Fatalf("file rewritten from %s to %s", body, after)
		}
	}
}
