package agentcli

var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

const (
	DefaultReleaseURL = "https://api.github.com/repos/hikariming/ghfind/releases/latest"
)

func VersionString() string {
	return "ghfind " + Version + " (" + Commit + ", " + Date + ")"
}
