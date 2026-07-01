package main

import (
	"os"

	"github.com/hikariming/github-roast/internal/agentcli"
)

func main() {
	os.Exit(agentcli.Execute(os.Args[1:], os.Stdout, os.Stderr))
}
