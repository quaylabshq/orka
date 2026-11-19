package server

import (
	"testing"
	"time"
)

func TestProjectPurgerDefaultsBoundWorkAndTombstoneLifetime(t *testing.T) {
	got := ProjectPurger{}.withDefaults()
	if got.Batch != projectPurgeBatch || got.TombstoneTTL != 90*24*time.Hour {
		t.Fatalf("unexpected defaults: %+v", got)
	}
	got = ProjectPurger{Batch: -1, TombstoneTTL: -time.Second}.withDefaults()
	if got.Batch != projectPurgeBatch || got.TombstoneTTL != projectTombstoneTTL {
		t.Fatalf("invalid settings were kept: %+v", got)
	}
	custom := ProjectPurger{Batch: 3, TombstoneTTL: time.Hour}
	if got = custom.withDefaults(); got != custom {
		t.Fatalf("explicit settings were replaced: %+v", got)
	}
}
