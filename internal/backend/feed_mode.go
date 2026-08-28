package backend

import "strings"

type FeedMode string

const (
	FeedModeOff         FeedMode = "off"
	FeedModeBaseline    FeedMode = "baseline"
	FeedModeGorseShadow FeedMode = "baseline_gorse_shadow"
	FeedModeGorseCanary FeedMode = "gorse_canary"
)

func ParseFeedMode(value string) FeedMode {
	mode := FeedMode(strings.ToLower(strings.TrimSpace(value)))
	if mode == "" {
		return FeedModeOff
	}
	return mode
}

func (m FeedMode) Valid() bool {
	switch m {
	case FeedModeOff, FeedModeBaseline, FeedModeGorseShadow, FeedModeGorseCanary:
		return true
	default:
		return false
	}
}

func (m FeedMode) Enabled() bool { return m.Valid() && m != FeedModeOff }
