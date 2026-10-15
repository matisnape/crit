package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResolveStampsResolvedRound_HTTP(t *testing.T) {
	srv, session := newTestServer(t)
	c, _ := session.AddComment("test.md", 1, 1, "", "fix this", "", "", "")

	session.Lock()
	session.ReviewRound = 3
	session.Unlock()

	req := httptest.NewRequest("PUT", "/api/comment/"+c.ID+"/resolve?path=test.md", strings.NewReader(`{"resolved": true}`))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("PUT resolve: status = %d, body = %s", w.Code, w.Body.String())
	}
	var got Comment
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if !got.Resolved {
		t.Fatal("expected resolved=true")
	}
	if got.ResolvedRound != 3 {
		t.Errorf("ResolvedRound = %d, want 3", got.ResolvedRound)
	}

	req = httptest.NewRequest("PUT", "/api/comment/"+c.ID+"/resolve?path=test.md", strings.NewReader(`{"resolved": false}`))
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("PUT unresolve: status = %d", w.Code)
	}
	var cleared Comment
	if err := json.Unmarshal(w.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.Resolved {
		t.Fatal("expected resolved=false after unresolve")
	}
	if cleared.ResolvedRound != 0 {
		t.Errorf("ResolvedRound after unresolve = %d, want 0", cleared.ResolvedRound)
	}
}

func TestResolveReviewCommentStampsResolvedRound_HTTP(t *testing.T) {
	srv, session := newTestServer(t)
	c := session.AddReviewComment("review note", "alice", "")

	session.Lock()
	session.ReviewRound = 4
	session.Unlock()

	req := httptest.NewRequest("PUT", "/api/review-comment/"+c.ID+"/resolve", strings.NewReader(`{"resolved": true}`))
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("PUT resolve: status = %d, body = %s", w.Code, w.Body.String())
	}
	var got Comment
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ResolvedRound != 4 {
		t.Errorf("ResolvedRound = %d, want 4", got.ResolvedRound)
	}

	req = httptest.NewRequest("PUT", "/api/review-comment/"+c.ID+"/resolve", strings.NewReader(`{"resolved": false}`))
	w = httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("PUT unresolve: status = %d", w.Code)
	}
	var cleared Comment
	if err := json.Unmarshal(w.Body.Bytes(), &cleared); err != nil {
		t.Fatal(err)
	}
	if cleared.ResolvedRound != 0 {
		t.Errorf("ResolvedRound after unresolve = %d, want 0", cleared.ResolvedRound)
	}
}

func TestAddReplyClearsResolvedRound(t *testing.T) {
	srv, session := newTestServer(t)
	c, _ := session.AddComment("test.md", 1, 1, "", "fix this", "", "", "")

	session.Lock()
	session.ReviewRound = 2
	session.Unlock()
	if _, ok := session.SetCommentResolved("test.md", c.ID, true); !ok {
		t.Fatal("SetCommentResolved failed")
	}

	body := strings.NewReader(`{"body": "actually not done", "author": "bob"}`)
	req := httptest.NewRequest("POST", "/api/comment/"+c.ID+"/replies?path=test.md", body)
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 201 {
		t.Fatalf("POST reply: status=%d body=%s", w.Code, w.Body.String())
	}

	session.RLock()
	got := session.Files[0].Comments[0]
	session.RUnlock()
	if got.Resolved {
		t.Error("expected Resolved=false after reply")
	}
	if got.ResolvedRound != 0 {
		t.Errorf("ResolvedRound after re-open = %d, want 0", got.ResolvedRound)
	}
}

func TestResolveAllComments_HTTP(t *testing.T) {
	srv, session := newTestServer(t)
	session.AddComment("test.md", 1, 1, "", "one", "", "", "")
	session.AddReviewComment("review note", "alice", "")

	cases := []struct {
		name, method, site string
		want               int
	}{
		{"get not allowed", "GET", "", 405},
		{"cross-site rejected", "POST", "cross-site", 403},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(tc.method, "/api/comments/resolve-all", nil)
		if tc.site != "" {
			req.Header.Set("Sec-Fetch-Site", tc.site)
		}
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, req)
		if w.Code != tc.want {
			t.Errorf("%s: status = %d, want %d", tc.name, w.Code, tc.want)
		}
	}
	if n := session.UnresolvedCommentCount(); n != 2 {
		t.Fatalf("rejected requests changed state: unresolved = %d, want 2", n)
	}

	req := httptest.NewRequest("POST", "/api/comments/resolve-all", nil)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("POST status = %d, body = %s", w.Code, w.Body.String())
	}
	var got struct {
		Resolved int `json:"resolved"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Resolved != 2 {
		t.Errorf("resolved = %d, want 2", got.Resolved)
	}
	if n := session.UnresolvedCommentCount(); n != 0 {
		t.Errorf("unresolved after = %d, want 0", n)
	}
}
