package backend

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestGoRuntimeDoesNotManageTursoSchema(t *testing.T) {
	ddl := regexp.MustCompile(`(?i)\b(CREATE|ALTER|DROP)\s+(TABLE|INDEX)\b`)
	roots := []string{
		".",
		filepath.Join("..", "..", "cmd", "ghfind-api"),
		filepath.Join("..", "..", "cmd", "ghfind-worker"),
	}
	var violations []string

	for _, root := range roots {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") || entry.Name() == "testdata" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			source, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if match := ddl.Find(source); match != nil {
				violations = append(violations, filepath.ToSlash(path)+": "+string(match))
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", root, err)
		}
	}

	if len(violations) > 0 {
		t.Fatalf("Go API/worker runtime must not create or migrate Turso schema:\n%s", strings.Join(violations, "\n"))
	}
}
