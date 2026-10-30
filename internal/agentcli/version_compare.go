package agentcli

import (
	"regexp"
	"strings"
)

// Keep abbreviated release tags (1 and 1.2) compatible with the existing CLI.
// Numeric identifiers are compared as strings to avoid overflow and rounding.
var releaseVersionPattern = regexp.MustCompile(`^(?:ghfind\s*)?[vV]?([0-9]+(?:\.[0-9]+){0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

type comparableVersion struct {
	core []string
	pre  []string
}

func numericIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func parseReleaseVersion(raw string) (comparableVersion, bool) {
	matches := releaseVersionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if matches == nil {
		return comparableVersion{}, false
	}
	version := comparableVersion{core: strings.Split(matches[1], ".")}
	for _, part := range version.core {
		if len(part) > 1 && part[0] == '0' {
			return comparableVersion{}, false
		}
	}
	for len(version.core) < 3 {
		version.core = append(version.core, "0")
	}
	if matches[2] != "" {
		version.pre = strings.Split(matches[2], ".")
		for _, part := range version.pre {
			if numericIdentifier(part) && len(part) > 1 && part[0] == '0' {
				return comparableVersion{}, false
			}
		}
	}
	return version, true
}

func compareNumericIdentifiers(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

func isNewerVersion(latest, current string) (bool, bool) {
	l, lok := parseReleaseVersion(latest)
	c, cok := parseReleaseVersion(current)
	if !lok || !cok {
		return false, false
	}
	for i := range l.core {
		if cmp := compareNumericIdentifiers(l.core[i], c.core[i]); cmp != 0 {
			return cmp > 0, true
		}
	}
	if len(l.pre) == 0 || len(c.pre) == 0 {
		return len(l.pre) == 0 && len(c.pre) > 0, true
	}
	for i := 0; i < len(l.pre) && i < len(c.pre); i++ {
		a, b := l.pre[i], c.pre[i]
		an, bn := numericIdentifier(a), numericIdentifier(b)
		if an != bn {
			return !an, true // Numeric prerelease identifiers sort before text.
		}
		cmp := strings.Compare(a, b)
		if an {
			cmp = compareNumericIdentifiers(a, b)
		}
		if cmp != 0 {
			return cmp > 0, true
		}
	}
	return len(l.pre) > len(c.pre), true
}
