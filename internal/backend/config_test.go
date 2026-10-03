package backend

import (
	"testing"
)

func TestLibSQLDSNKeepsRemoteURLTokenFree(t *testing.T) {
	config := Config{TursoURL: "libsql://ghfind-test.turso.io", TursoAuth: "secret token"}
	dsn, err := config.LibSQLDSN()
	if err != nil {
		t.Fatal(err)
	}
	want := "libsql://ghfind-test.turso.io"
	if dsn != want {
		t.Fatalf("DSN = %q, want %q", dsn, want)
	}
}

func TestLibSQLDSNLeavesLocalFileTokenFree(t *testing.T) {
	config := Config{TursoURL: "file:./local.db", TursoAuth: "must-not-appear"}
	dsn, err := config.LibSQLDSN()
	if err != nil {
		t.Fatal(err)
	}
	if dsn != "file:./local.db" {
		t.Fatalf("DSN = %q", dsn)
	}
}
