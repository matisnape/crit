package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"

	"github.com/tomasz-tomczyk/crit/internal/uisettings"
)

// uiSettingsMarker in index.html / themes.html is replaced with the stored
// settings, so the first paint already uses the saved theme (no fetch).
var uiSettingsMarker = []byte("<!-- crit:ui-settings -->")

// handleUISettings serves ~/.crit/ui-settings.json. Not behind withReady:
// live and preview pages load before the session exists. PATCH merges only
// the sent keys (null resets one to its default); DELETE removes the file.
// Cross-site writes are refused by ServeHTTP's Sec-Fetch-Site check.
func (s *Server) handleUISettings(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		snap, _ := uisettings.Load()
		writeJSON(w, snap)
	case http.MethodPatch:
		var changes map[string]any
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&changes); err != nil {
			http.Error(w, "invalid JSON body", http.StatusBadRequest)
			return
		}
		for k, v := range changes {
			if v == nil && uisettings.IsSetting(k) {
				continue
			}
			if err := uisettings.Validate(k, v); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
		snap, err := uisettings.Save(changes, false)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error(), "path": snap.Path})
			return
		}
		writeJSON(w, snap)
	case http.MethodDelete:
		if err := uisettings.Reset(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

// pageUISettings returns the snapshot to embed in a page. When no file exists
// yet, the Settings-dialog keys of this host's crit-settings cookie (where
// older versions kept them) become the file, once.
func pageUISettings(r *http.Request) uisettings.Snapshot {
	snap, _ := uisettings.Load()
	if snap.Exists {
		return snap
	}
	c, err := r.Cookie("crit-settings")
	if err != nil {
		return snap
	}
	raw, err := url.PathUnescape(c.Value)
	if err != nil {
		return snap
	}
	var cookie map[string]any
	if json.Unmarshal([]byte(raw), &cookie) != nil {
		return snap
	}
	found := map[string]any{}
	for k, v := range cookie {
		if uisettings.IsSetting(k) && uisettings.Validate(k, v) == nil {
			found[k] = v
		}
	}
	if len(found) == 0 {
		return snap
	}
	if saved, err := uisettings.Save(found, true); err == nil {
		return saved
	}
	snap.Settings = found // unwritable: still show this page with them
	return snap
}

func injectUISettings(page []byte, r *http.Request) []byte {
	data, err := json.Marshal(pageUISettings(r)) // escapes <, > and &
	if err != nil {
		return page
	}
	script := append(append([]byte("<script>window.critUISettings="), data...), ";</script>"...)
	return bytes.Replace(page, uiSettingsMarker, script, 1)
}
