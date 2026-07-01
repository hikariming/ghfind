package agentcli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
)

type globalOptions struct {
	Host           string
	APIKey         string
	TurnstileToken string
	Output         string
	Lang           string
	JSON           bool
	Help           bool
}

func Execute(args []string, stdout io.Writer, stderr io.Writer) int {
	positional, opts, err := parseArgs(args)
	if err != nil {
		return exitError(stderr, err)
	}
	if len(positional) == 0 || opts.Help {
		printHelp(stdout)
		return 0
	}

	switch positional[0] {
	case "commands":
		return runCommands(positional[1:], opts, stdout, stderr)
	case "auth":
		if len(positional) > 1 && positional[1] == "status" {
			return runAuthStatus(opts, stdout)
		}
		return exitError(stderr, fmt.Errorf("unknown auth command"))
	default:
		return exitError(stderr, fmt.Errorf("unknown command: %s", positional[0]))
	}
}

func parseArgs(args []string) ([]string, globalOptions, error) {
	opts := globalOptions{
		Host:           envOrDefault("GITHUB_ROAST_HOST", DefaultHost),
		APIKey:         os.Getenv("GITHUB_ROAST_API_KEY"),
		TurnstileToken: os.Getenv("GITHUB_ROAST_TURNSTILE_TOKEN"),
		Output:         "pretty",
		Lang:           "zh",
	}
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--json":
			opts.JSON = true
			opts.Output = "json"
		case "-h", "--help":
			opts.Help = true
		case "-o", "--output":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Output = args[i]
		case "--host":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Host = args[i]
		case "--api-key":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.APIKey = args[i]
		case "--turnstile-token":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.TurnstileToken = args[i]
		case "--lang":
			i++
			if i >= len(args) {
				return nil, opts, fmt.Errorf("%s requires a value", arg)
			}
			opts.Lang = args[i]
		default:
			positional = append(positional, arg)
		}
	}
	opts.Host = strings.TrimRight(opts.Host, "/")
	return positional, opts, nil
}

func runCommands(args []string, opts globalOptions, stdout io.Writer, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "show" {
		if len(args) < 2 {
			return exitError(stderr, fmt.Errorf("missing command name"))
		}
		cmd, ok := findCommand(strings.ReplaceAll(args[1], "-", " "))
		if !ok {
			return exitError(stderr, fmt.Errorf("unknown command: %s", args[1]))
		}
		if opts.JSON {
			return writeJSON(stdout, cmd)
		}
		fmt.Fprintf(stdout, "%s\nusage: %s\n%s\n", cmd.Name, cmd.Usage, cmd.Summary)
		return 0
	}

	payload := struct {
		DefaultHost string        `json:"default_host"`
		Commands    []CommandInfo `json:"commands"`
	}{DefaultHost: DefaultHost, Commands: commandCatalog}
	if opts.JSON {
		return writeJSON(stdout, payload)
	}
	for _, cmd := range commandCatalog {
		fmt.Fprintf(stdout, "%s\t%s\n", cmd.Name, cmd.Summary)
	}
	return 0
}

func runAuthStatus(opts globalOptions, stdout io.Writer) int {
	payload := map[string]any{
		"host":                opts.Host,
		"default_host":        DefaultHost,
		"has_api_key":         opts.APIKey != "",
		"has_turnstile_token": opts.TurnstileToken != "",
	}
	if opts.Output == "json" {
		return writeJSON(stdout, payload)
	}
	fmt.Fprintf(stdout, "host: %s\n", payload["host"])
	fmt.Fprintf(stdout, "api key: %s\n", configured(payload["has_api_key"].(bool)))
	fmt.Fprintf(stdout, "turnstile token: %s\n", configured(payload["has_turnstile_token"].(bool)))
	return 0
}

func printHelp(stdout io.Writer) {
	fmt.Fprintln(stdout, "github-roast CLI")
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Remote CLI for the ghfind.com GitHub Roast website APIs.")
	fmt.Fprintln(stdout)
	fmt.Fprintln(stdout, "Commands:")
	for _, cmd := range commandCatalog {
		fmt.Fprintf(stdout, "  %s\t%s\n", cmd.Name, cmd.Summary)
	}
}

func writeJSON(stdout io.Writer, v any) int {
	enc := json.NewEncoder(stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(v); err != nil {
		return 1
	}
	return 0
}

func exitError(stderr io.Writer, err error) int {
	fmt.Fprintln(stderr, err.Error())
	return 1
}

func envOrDefault(key string, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func configured(ok bool) string {
	if ok {
		return "configured"
	}
	return "missing"
}
