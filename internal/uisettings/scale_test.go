package uisettings

import (
	"strings"
	"testing"

	"github.com/tomasz-tomczyk/crit/internal/testutil"
)

func TestCRIT03_7_ScaleAcceptsOnlyOfferedPercentages(t *testing.T) {
	for _, v := range []float64{75, 80, 90, 100, 110, 125} {
		if err := Validate("scale", v); err != nil {
			t.Errorf("scale %v rejected: %v", v, err)
		}
	}
	for _, v := range []any{300.0, 0.0, -5.0, 80.5, "big", "90", true, nil} {
		if err := Validate("scale", v); err == nil {
			t.Errorf("scale %v accepted", v)
		}
	}
	if !IsSetting("scale") {
		t.Fatal("scale is not a setting")
	}
}

func TestCRIT03_7_InvalidStoredScaleFallsBackToDefault(t *testing.T) {
	for _, raw := range []string{"300", "0", "-5", `"big"`} {
		path := settingsFile(t)
		testutil.WriteFile(t, path, `{"scale":`+raw+`,"theme":"dark"}`)
		snap, problem := Load()
		if _, ok := snap.Settings["scale"]; ok {
			t.Errorf("scale %s kept: %v", raw, snap.Settings["scale"])
		}
		if !strings.Contains(problem, "scale") || snap.Settings["theme"] != "dark" {
			t.Errorf("scale %s: problem %q, settings %+v", raw, problem, snap.Settings)
		}
	}
}

func TestCRIT03_6_ScaleIsSaved(t *testing.T) {
	settingsFile(t)
	if _, err := Save(map[string]any{"scale": 90.0}, false); err != nil {
		t.Fatal(err)
	}
	snap, problem := Load()
	if problem != "" || snap.Settings["scale"] != 90.0 {
		t.Fatalf("snapshot %+v, problem %q", snap, problem)
	}
}
