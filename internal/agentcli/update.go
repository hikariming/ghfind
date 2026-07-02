package agentcli

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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
	Assets  []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

type UpdateInstallOptions struct {
	ReleaseURL string
	Method     string
	TargetPath string
	AssetURL   string
	DryRun     bool
}

type UpdateInstallResult struct {
	Name            string   `json:"name"`
	CurrentVersion  string   `json:"current_version"`
	LatestVersion   string   `json:"latest_version,omitempty"`
	UpdateAvailable bool     `json:"update_available"`
	Method          string   `json:"method"`
	TargetPath      string   `json:"target_path,omitempty"`
	AssetName       string   `json:"asset_name,omitempty"`
	AssetURL        string   `json:"asset_url,omitempty"`
	Command         []string `json:"command,omitempty"`
	ReleaseURL      string   `json:"release_url,omitempty"`
	CheckedURL      string   `json:"checked_url,omitempty"`
	Status          string   `json:"status"`
	Message         string   `json:"message"`
	DryRun          bool     `json:"dry_run,omitempty"`
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

func InstallUpdate(ctx context.Context, httpClient HTTPDoer, opts UpdateInstallOptions) (UpdateInstallResult, error) {
	method := opts.Method
	if method == "" {
		method = "binary"
	}
	switch method {
	case "binary":
		return installBinaryUpdate(ctx, httpClient, opts)
	case "npm", "pip", "brew":
		return installPackageManagerUpdate(ctx, method, opts.DryRun)
	default:
		return UpdateInstallResult{}, fmt.Errorf("invalid update method: %s", method)
	}
}

func installBinaryUpdate(ctx context.Context, httpClient HTTPDoer, opts UpdateInstallOptions) (UpdateInstallResult, error) {
	if runtime.GOOS == "windows" {
		return UpdateInstallResult{}, fmt.Errorf("binary self-update is not supported on Windows; use --method npm, pip, or brew")
	}
	release, checkedURL, err := fetchLatestRelease(ctx, httpClient, opts.ReleaseURL)
	if err != nil {
		return UpdateInstallResult{}, err
	}
	assetName, assetURL, err := selectReleaseAsset(release, opts.AssetURL)
	if err != nil {
		return UpdateInstallResult{}, err
	}
	targetPath := opts.TargetPath
	if targetPath == "" {
		targetPath, err = os.Executable()
		if err != nil {
			return UpdateInstallResult{}, err
		}
	}
	targetPath, err = filepath.Abs(targetPath)
	if err != nil {
		return UpdateInstallResult{}, err
	}
	updateAvailable, comparable := isNewerVersion(release.TagName, Version)
	result := UpdateInstallResult{
		Name:            "ghfind",
		CurrentVersion:  Version,
		LatestVersion:   release.TagName,
		UpdateAvailable: updateAvailable && comparable,
		Method:          "binary",
		TargetPath:      targetPath,
		AssetName:       assetName,
		AssetURL:        assetURL,
		ReleaseURL:      release.HTMLURL,
		Status:          "current",
		Message:         "ghfind is already up to date.",
		DryRun:          opts.DryRun,
	}
	if Version == "dev" || !comparable {
		result.Status = "installable"
		result.Message = "Current version is not comparable; installing the latest release asset is allowed."
	} else if updateAvailable {
		result.Status = "update_available"
		result.Message = "A newer ghfind CLI release is available."
	}
	if opts.DryRun {
		result.Status = "dry_run"
		result.Message = "Dry run only; no files were changed."
		return result, nil
	}
	if result.Status == "current" {
		return result, nil
	}
	if err := downloadAndReplace(ctx, httpClient, assetURL, targetPath); err != nil {
		return UpdateInstallResult{}, err
	}
	result.Status = "updated"
	result.Message = "ghfind binary was updated."
	result.CheckedURL = checkedURL
	return result, nil
}

func installPackageManagerUpdate(ctx context.Context, method string, dryRun bool) (UpdateInstallResult, error) {
	command, err := packageManagerCommand(method)
	if err != nil {
		return UpdateInstallResult{}, err
	}
	result := UpdateInstallResult{
		Name:           "ghfind",
		CurrentVersion: Version,
		Method:         method,
		Command:        command,
		Status:         "ready",
		Message:        "Package manager upgrade is ready.",
		DryRun:         dryRun,
	}
	if dryRun {
		result.Status = "dry_run"
		result.Message = "Dry run only; command was not executed."
		return result, nil
	}
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return UpdateInstallResult{}, fmt.Errorf("%s failed: %w\n%s", method, err, strings.TrimSpace(string(output)))
	}
	result.Status = "updated"
	result.Message = "Package manager upgrade completed."
	return result, nil
}

func fetchLatestRelease(ctx context.Context, httpClient HTTPDoer, releaseURL string) (latestRelease, string, error) {
	if releaseURL == "" {
		releaseURL = DefaultReleaseURL
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, releaseURL, nil)
	if err != nil {
		return latestRelease{}, releaseURL, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "ghfind-cli")
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return latestRelease{}, releaseURL, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return latestRelease{}, releaseURL, readAPIError(res)
	}
	var release latestRelease
	if err := json.NewDecoder(res.Body).Decode(&release); err != nil {
		return latestRelease{}, releaseURL, err
	}
	return release, releaseURL, nil
}

func selectReleaseAsset(release latestRelease, overrideURL string) (string, string, error) {
	if overrideURL != "" {
		return "custom", overrideURL, nil
	}
	want := releaseAssetName()
	for _, asset := range release.Assets {
		if asset.Name == want && asset.BrowserDownloadURL != "" {
			return asset.Name, asset.BrowserDownloadURL, nil
		}
	}
	return "", "", fmt.Errorf("release %s does not contain asset %s", release.TagName, want)
}

func releaseAssetName() string {
	name := "ghfind-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

func downloadAndReplace(ctx context.Context, httpClient HTTPDoer, assetURL string, targetPath string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ghfind-cli")
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 120 * time.Second}
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return readAPIError(res)
	}
	info, err := os.Stat(targetPath)
	if err != nil {
		return err
	}
	tmpPath := targetPath + ".new"
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(tmp, res.Body)
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return closeErr
	}
	if err := os.Chmod(tmpPath, info.Mode().Perm()); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	backupPath := targetPath + ".old"
	_ = os.Remove(backupPath)
	if err := os.Rename(targetPath, backupPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		_ = os.Rename(backupPath, targetPath)
		_ = os.Remove(tmpPath)
		return err
	}
	_ = os.Remove(backupPath)
	return nil
}

func packageManagerCommand(method string) ([]string, error) {
	switch method {
	case "npm":
		return []string{"npm", "install", "-g", "@hikariming/ghfind@latest"}, nil
	case "pip":
		return []string{"python3", "-m", "pip", "install", "--upgrade", "ghfind"}, nil
	case "brew":
		return []string{"brew", "upgrade", "ghfind"}, nil
	default:
		return nil, fmt.Errorf("invalid update method: %s", method)
	}
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

func formatUpdateInstallResult(result UpdateInstallResult) string {
	var b strings.Builder
	fmt.Fprintf(&b, "ghfind update method: %s\n", result.Method)
	fmt.Fprintf(&b, "current: %s\n", result.CurrentVersion)
	if result.LatestVersion != "" {
		fmt.Fprintf(&b, "latest: %s\n", result.LatestVersion)
	}
	fmt.Fprintf(&b, "status: %s\n", result.Status)
	fmt.Fprintf(&b, "%s\n", result.Message)
	if result.TargetPath != "" {
		fmt.Fprintf(&b, "target: %s\n", result.TargetPath)
	}
	if result.AssetURL != "" {
		fmt.Fprintf(&b, "asset: %s\n", result.AssetURL)
	}
	if len(result.Command) > 0 {
		fmt.Fprintf(&b, "command: %s\n", strings.Join(result.Command, " "))
	}
	return strings.TrimRight(b.String(), "\n")
}
