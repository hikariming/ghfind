package agentcli

var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

func VersionString() string {
	return "github-roast " + Version + " (" + Commit + ", " + Date + ")"
}
