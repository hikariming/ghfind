package agentcli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type UpdateInfo struct {
	Name            string `json:"name"`
	CurrentVersion  string `json:"current_version"`
	LatestVersion   string `json:"latest_version,omitempty"`
	UpdateAvailable bool   `json:"update_available"`
	ReleaseURL      string `json:"release_url,omitempty"`
	CheckedURL      string `json:"checked_url"`
	Status          string `json:"status"`
	Message         string `json:"message"`
}

type latestRelease struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

func CheckUpdate(ctx context.Context, httpClient HTTPDoer, releaseURL string) (UpdateInfo, error) {
	if releaseURL == "" {
		releaseURL = DefaultReleaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releaseURL, nil)
	if err != nil {
		return UpdateInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ghfind-cli")

	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return UpdateInfo{}, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return UpdateInfo{
			Name:           "ghfind",
			CurrentVersion: Version,
			CheckedURL:     releaseURL,
			Status:         "no_release",
			Message:        "No GitHub release is published yet.",
		}, nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return UpdateInfo{}, readAPIError(res)
	}

	var latest latestRelease
	if err := json.NewDecoder(res.Body).Decode(&latest); err != nil {
		return UpdateInfo{}, err
	}
	updateAvailable, comparable := isNewerVersion(latest.TagName, Version)
	status := "current"
	message := "ghfind is up to date."
	if Version == "dev" || Version == "" {
		status = "dev_build"
		message = "This is a dev build; compare manually with the latest release."
	} else if !comparable {
		status = "unknown"
		message = "Could not compare versions; compare manually with the latest release."
	} else if updateAvailable {
		status = "update_available"
		message = "A newer ghfind CLI release is available."
	}
	return UpdateInfo{
		Name:            "ghfind",
		CurrentVersion:  Version,
		LatestVersion:   latest.TagName,
		UpdateAvailable: updateAvailable && comparable,
		ReleaseURL:      latest.HTMLURL,
		CheckedURL:      releaseURL,
		Status:          status,
		Message:         message,
	}, nil
}

func isNewerVersion(latest string, current string) (bool, bool) {
	latestParts, okLatest := parseVersionParts(latest)
	currentParts, okCurrent := parseVersionParts(current)
	if !okLatest || !okCurrent {
		return false, false
	}
	for i := 0; i < len(latestParts) || i < len(currentParts); i++ {
		var l, c int
		if i < len(latestParts) {
			l = latestParts[i]
		}
		if i < len(currentParts) {
			c = currentParts[i]
		}
		if l > c {
			return true, true
		}
		if l < c {
			return false, true
		}
	}
	return false, true
}

func parseVersionParts(version string) ([]int, bool) {
	version = strings.TrimSpace(version)
	version = strings.TrimPrefix(version, "ghfind")
	version = strings.TrimSpace(strings.TrimPrefix(version, "v"))
	if version == "" || version == "dev" {
		return nil, false
	}
	fields := strings.FieldsFunc(version, func(r rune) bool {
		return r == '-' || r == '+'
	})
	if len(fields) == 0 {
		return nil, false
	}
	main := fields[0]
	segments := strings.Split(main, ".")
	parts := make([]int, 0, len(segments))
	for _, segment := range segments {
		if segment == "" {
			return nil, false
		}
		value, err := strconv.Atoi(segment)
		if err != nil {
			return nil, false
		}
		parts = append(parts, value)
	}
	return parts, true
}

func formatUpdateInfo(info UpdateInfo) string {
	var b strings.Builder
	fmt.Fprintf(&b, "ghfind current: %s\n", info.CurrentVersion)
	if info.LatestVersion != "" {
		fmt.Fprintf(&b, "latest: %s\n", info.LatestVersion)
	}
	fmt.Fprintf(&b, "status: %s\n", info.Status)
	fmt.Fprintf(&b, "%s\n", info.Message)
	if info.ReleaseURL != "" {
		fmt.Fprintf(&b, "release: %s\n", info.ReleaseURL)
	}
	return strings.TrimRight(b.String(), "\n")
}
