package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/tomasz-tomczyk/crit/internal/testutil"
)

func uiSettingsHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	testutil.SetHome(t, home)
	return filepath.Join(home, ".crit", "ui-settings.json")
}

func serve(t *testing.T, s *Server, method, target, body string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	for k, v := range header {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	return w
}

var injected = regexp.MustCompile(`<script>window\.critUISettings=(.*?);</script>`)

// injectedSnapshot returns the settings snapshot a page embeds before its
// first stylesheet-dependent script, or fails when the page has none.
func injectedSnapshot(t *testing.T, html string) map[string]any {
	t.Helper()
	m := injected.FindStringSubmatch(html)
	if m == nil {
		t.Fatalf("no injected settings in page:\n%.400s", html)
	}
	var snap map[string]any
	if err := json.Unmarshal([]byte(m[1]), &snap); err != nil {
		t.Fatal(err)
	}
	return snap
}

func TestCRIT02_5_EveryPageEmbedsStoredSettingsBeforePaint(t *testing.T) {
	path := uiSettingsHome(t)
	testutil.WriteFile(t, path, `{"theme":"dark"}`)
	s, _ := newTestServer(t)
	for _, p := range []string{"/", "/index.html", "/live", "/preview", "/themes", "/themes.html"} {
		w := serve(t, s, http.MethodGet, p, "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d", p, w.Code)
		}
		body := w.Body.String()
		snap := injectedSnapshot(t, body)
		if snap["settings"].(map[string]any)["theme"] != "dark" {
			t.Errorf("%s: snapshot %v", p, snap)
		}
		// The data must be there before the palette script and the stylesheets
		// are applied by the head scripts.
		if strings.Index(body, "window.critUISettings") > strings.Index(body, "crit-theme-palette.js") {
			t.Errorf("%s: settings injected after crit-theme-palette.js", p)
		}
		if cc := w.Header().Get("Cache-Control"); cc != "no-store" {
			t.Errorf("%s: Cache-Control %q", p, cc)
		}
	}
}

func TestCRIT02_5_InjectedSettingsCannotCloseTheScriptTag(t *testing.T) {
	path := uiSettingsHome(t)
	testutil.WriteFile(t, path, `{"codeFont":"</script><script>alert(1)</script>"}`)
	s, _ := newTestServer(t)
	body := serve(t, s, http.MethodGet, "/", "", nil).Body.String()
	if strings.Contains(body, "</script><script>alert(1)") {
		t.Fatal("stored value broke out of the script tag")
	}
	if got := injectedSnapshot(t, body)["settings"].(map[string]any)["codeFont"]; got != "</script><script>alert(1)</script>" {
		t.Fatalf("codeFont = %v", got)
	}
}

func TestCRIT02_1_PatchSavesAndGetReturnsSettings(t *testing.T) {
	path := uiSettingsHome(t)
	s, _ := newTestServer(t)
	w := serve(t, s, http.MethodPatch, "/api/ui-settings", `{"theme":"dark"}`, map[string]string{"Sec-Fetch-Site": "same-origin"})
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH: %d %s", w.Code, w.Body)
	}
	data, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(data), `"dark"`) {
		t.Fatalf("file: %s %v", data, err)
	}
	w = serve(t, s, http.MethodGet, "/api/ui-settings", "", nil)
	var snap struct {
		Exists   bool
		Path     string
		Settings map[string]any
	}
	if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil {
		t.Fatal(err)
	}
	if !snap.Exists || snap.Path != path || snap.Settings["theme"] != "dark" {
		t.Fatalf("GET: %+v", snap)
	}
}

func TestCRIT02_2_PatchRejectsInvalidValues(t *testing.T) {
	path := uiSettingsHome(t)
	s, _ := newTestServer(t)
	for _, body := range []string{`{"theme":"purple"}`, `{"fileTreeWidth":300}`, `not json`} {
		if w := serve(t, s, http.MethodPatch, "/api/ui-settings", body, nil); w.Code != http.StatusBadRequest {
			t.Errorf("%s: %d", body, w.Code)
		}
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("rejected PATCH wrote the file: %v", err)
	}
}

func TestCRIT02_9_CrossSiteChangeIsRejected(t *testing.T) {
	path := uiSettingsHome(t)
	testutil.WriteFile(t, path, `{"theme":"light"}`)
	before, _ := os.ReadFile(path)
	s, _ := newTestServer(t)
	for _, m := range []string{http.MethodPatch, http.MethodDelete} {
		w := serve(t, s, m, "/api/ui-settings", `{"theme":"dark"}`, map[string]string{"Sec-Fetch-Site": "cross-site"})
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "Sec-Fetch-Site") {
			t.Errorf("%s: %d %s", m, w.Code, w.Body)
		}
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(before) {
		t.Fatalf("file changed: %s", after)
	}
}

func TestCRIT02_8_UnwritableFileReturnsErrorNamingFile(t *testing.T) {
	path := uiSettingsHome(t)
	testutil.WriteFile(t, path, `{"theme":"light"}`)
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatal(err)
	}
	s, _ := newTestServer(t)
	w := serve(t, s, http.MethodPatch, "/api/ui-settings", `{"theme":"dark"}`, nil)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("code %d", w.Code)
	}
	var resp struct{ Error, Path string }
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%v: %s", err, w.Body)
	}
	if resp.Path != path || !strings.Contains(resp.Error, path) {
		t.Fatalf("resp = %+v", resp)
	}
}

func cookieHeader(v map[string]any) map[string]string {
	b, _ := json.Marshal(v)
	// encodeURIComponent, as web/crit-shared.js setCookie writes it.
	return map[string]string{"Cookie": "crit-settings=" + strings.ReplaceAll(url.QueryEscape(string(b)), "+", "%20")}
}

func TestCRIT02_4_FirstPageLoadImportsDialogKeysFromCookie(t *testing.T) {
	path := uiSettingsHome(t)
	s, _ := newTestServer(t)
	cookie := cookieHeader(map[string]any{
		"theme": "light", "lightPalette": "ayu-light", "fileTreeWidth": 320,
		"live_commentsPanelWidth": 400, "live_commentsPanelOpen": false, "diffScope": "all",
	})
	snap := injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", cookie).Body.String())
	settings := snap["settings"].(map[string]any)
	if settings["theme"] != "light" || settings["lightPalette"] != "ayu-light" || len(settings) != 2 {
		t.Fatalf("injected = %v", settings)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var stored map[string]any
	if err := json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 || stored["theme"] != "light" || stored["lightPalette"] != "ayu-light" {
		t.Fatalf("stored = %v", stored)
	}

	// Once the file exists, another host's cookie does not overwrite it.
	other := cookieHeader(map[string]any{"theme": "dark", "lightPalette": "github-light-default"})
	snap = injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", other).Body.String())
	if snap["settings"].(map[string]any)["theme"] != "light" {
		t.Fatalf("second cookie applied: %v", snap)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(data) {
		t.Fatalf("file overwritten: %s", after)
	}
}

func TestCRIT02_4_CookieWithoutDialogKeysCreatesNoFile(t *testing.T) {
	path := uiSettingsHome(t)
	s, _ := newTestServer(t)
	snap := injectedSnapshot(t, serve(t, s, http.MethodGet, "/", "", cookieHeader(map[string]any{"diffScope": "all"})).Body.String())
	if snap["exists"] != false {
		t.Fatalf("snap = %v", snap)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file created: %v", err)
	}
}

func TestCRIT02_4_DeleteResetsToDefaults(t *testing.T) {
	path := uiSettingsHome(t)
	testutil.WriteFile(t, path, `{"theme":"light"}`)
	s, _ := newTestServer(t)
	if w := serve(t, s, http.MethodDelete, "/api/ui-settings", "", nil); w.Code != http.StatusNoContent {
		t.Fatalf("DELETE: %d", w.Code)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file still there: %v", err)
	}
}
