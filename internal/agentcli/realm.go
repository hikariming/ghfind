package agentcli

import (
	"encoding/json"
	"fmt"
	"math"
)

// Display-only cultivation realm + adventurer level. Mirrors src/lib/realm.ts.
// Does not change scoring or stored tier keys.

type realmDef struct {
	minScore float64
	nameZh   string
	nameEn   string
}

var realmDefs = []realmDef{
	{0, "练气", "Qi Condensation"},
	{30, "筑基", "Foundation Est."},
	{40, "金丹", "Core Formation"},
	{50, "元婴", "Nascent Soul"},
	{60, "化神", "Deity Transformation"},
	{70, "炼虚", "Spatial Tempering"},
	{80, "合体", "Body Integration"},
	{90, "大乘", "Grand Ascension"},
}

func adventurerLevel(score float64) int {
	if math.IsNaN(score) || math.IsInf(score, 0) {
		return 1
	}
	lv := int(math.Floor(score))
	if lv < 1 {
		return 1
	}
	if lv > 100 {
		return 100
	}
	return lv
}

func realmForScore(score float64) realmDef {
	current := realmDefs[0]
	for _, r := range realmDefs {
		if score >= r.minScore {
			current = r
		}
	}
	return current
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	case string:
		var f float64
		_, err := fmt.Sscanf(n, "%f", &f)
		return f, err == nil
	default:
		return 0, false
	}
}

func formatLevelRealm(score any, lang string) string {
	f, ok := asFloat(score)
	if !ok {
		f = 0
	}
	r := realmForScore(f)
	name := r.nameEn
	if lang == "zh" || lang == "zh-CN" || lang == "zh-Hans" {
		name = r.nameZh
	}
	return fmt.Sprintf("Lv.%d %s", adventurerLevel(f), name)
}
