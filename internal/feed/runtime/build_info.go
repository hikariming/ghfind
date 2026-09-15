package runtime

import (
	"encoding/json"
	"io"
)

// WriteBuildInfo reports only compiled process identity. It performs no config,
// database or network initialization and is used to inspect an actual image.
func WriteBuildInfo(w io.Writer, service, version, imageBuildID string) error {
	return json.NewEncoder(w).Encode(struct {
		Service      string `json:"service"`
		Version      string `json:"version"`
		ImageBuildID string `json:"imageBuildId"`
	}{service, version, imageBuildID})
}
