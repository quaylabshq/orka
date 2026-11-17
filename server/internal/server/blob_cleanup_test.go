package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBlobCleanupIsIdempotentAndRejectsUnsafePaths(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	project := newID()
	data := []byte("Retained complete session\n")
	hash := bytesHash(data)
	store := &Blobs{Root: root}
	if _, err := store.Put(project, data); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(project, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(project, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove("../outside", hash); err == nil {
		t.Fatal("accepted invalid project")
	}
	if err := store.Remove(project, "../../outside"); err == nil {
		t.Fatal("accepted invalid hash")
	}
	target := filepath.Join(outside, hash)
	if err := os.WriteFile(target, data, 0600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, project, hash)
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(project, hash); err == nil {
		t.Fatal("accepted symlink file")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, project)); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, project)); err != nil {
		t.Fatal(err)
	}
	if err := store.Remove(project, hash); err == nil {
		t.Fatal("accepted symlink project")
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != string(data) {
		t.Fatal("outside file changed", err)
	}
}
