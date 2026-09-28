// Package feedtransfer validates bounded offline transfer protocols. It does not
// capture mutations, connect to a database, apply rows or promote a writer.
//
// This is NOT a complete change journal. Current PostgreSQL user deletion can
// cascade across hundreds of thousands of rows; retention also uses unbounded
// deletes. These transactions cannot fit v1's row limits. Connecting capture or
// promotion before a separately reviewed large-transaction protocol is unsafe.
// Never split, truncate or omit those transactions to make them fit.
package feedtransfer

import "sort"

type TableRule struct {
	Table    string `json:"table"`
	Mode     string `json:"mode"`     // capture, empty, or reinitialize; never silently omit derived controls
	Category string `json:"category"` // fact, control, derived, or legacy
	Privacy  string `json:"privacy"`  // shared, actor, mixed, or control
}

// Registry is a coverage inventory, not a row mapper. Physical column validation
// remains a prerequisite of a future schema-aware capture/apply adapter.
type Registry struct {
	Profile        string      `json:"profile"`
	Schema         int64       `json:"schema"`
	WriterContract int64       `json:"writerContract"`
	Tables         []TableRule `json:"tables"`
}

// RequiredRegistry selects the current physical schema. Historical manifests use
// RegistryForSchema so their serialized coverage and digests remain unchanged.
func RequiredRegistry(profile string) (Registry, error) {
	schema := int64(22)
	if profile == "cf_d1_r2" {
		schema = 12
	}
	return RegistryForSchema(profile, schema)
}

func RegistryForSchema(profile string, schema int64) (Registry, error) {
	r := Registry{Profile: profile, WriterContract: 2}
	add := func(mode, privacy string, names ...string) {
		for _, name := range names {
			r.Tables = append(r.Tables, TableRule{Table: name, Mode: mode, Category: "fact", Privacy: privacy})
		}
	}
	switch profile {
	case "cf_d1_r2":
		if schema != 11 && schema != 12 {
			return Registry{}, invalid("identity")
		}
		r.Schema = schema
		if schema == 12 {
			add("empty", "control", "feed_adapter_write_context")
			// Capture/apply must initialize enabled=1 independently, never replay
			// the source authorization state. No row mapper is implemented here.
			add("reinitialize", "control", "feed_adapter_write_fence")
		}
		add("empty", "control", "feed_archive_guards", "feed_command_guards", "feed_delivery_guards", "feed_execution_guards", "feed_operator_guards", "feed_projection_commands", "feed_proposal_guards", "feed_governance_guards")
		add("capture", "actor", "feed_behavior_signals", "feed_events", "feed_runtime_events", "feed_runtime_requests", "feed_runtime_served_metadata", "feed_runtime_sessions", "feed_served_items", "feed_tag_proposal_commands", "feed_user_project_states", "feed_user_proposal_authors", "feed_user_tag_preferences", "feed_user_tag_proposals", "feed_users")
		add("capture", "control", "feed_archive_objects", "feed_cleanup_jobs", "feed_profile_deletions", "feed_profile_floors")
		add("capture", "mixed", "feed_runtime_outbox", "feed_rate_windows")
		add("capture", "shared", "feed_cleanup_policy", "feed_delivery_heads", "feed_delivery_terminals", "feed_execution_jobs", "feed_operator_actions", "feed_project_moderation", "feed_project_source_versions", "feed_project_tags", "feed_projects", "feed_replay_deliveries", "feed_runtime_control", "feed_schema_compatibility", "feed_submission_provenance", "feed_tag_aliases", "feed_tag_definitions", "feed_tag_proposals", "feed_taxonomy_versions", "feed_governance_commands")
	case "postgres":
		if schema != 22 {
			return Registry{}, invalid("identity")
		}
		r.Schema = 22
		add("capture", "actor", "feed.users", "feed.user_tag_preferences", "feed.user_project_state", "feed.user_profile_embeddings", "feed.requests", "feed.served_items", "feed.events", "feed.sessions", "feed.tag_proposal_commands", "feed.user_proposal_authors", "feed.behavior_signals")
		add("capture", "control", "feed.user_deletion_tombstones", "feed.archive_objects")
		add("capture", "mixed", "feed.tag_proposals", "feed.event_outbox", "feed.gorse_shadow_results")
		add("capture", "shared", "feed.taxonomy_versions", "feed.tag_definitions", "feed.tag_aliases", "feed.projects", "feed.project_tags", "feed.project_embeddings", "feed.tag_embeddings", "feed.projection_cursors", "feed.projection_failures", "feed.algorithm_configs", "feed.project_moderation_actions", "feed.embedding_model_state", "feed.jobs", "feed.runtime_control", "feed.project_submission_evidence", "feed.governance_commands", "feed.schema_compatibility")
	default:
		return Registry{}, invalid("unknown_profile")
	}
	// Capture inventory includes every physical relation, but this is NOT a
	// claim that legacy/derived rows map to primary facts in the other profile.
	legacy := map[string]bool{"feed.gorse_shadow_results": true, "feed.algorithm_configs": true, "feed.projection_cursors": true, "feed.projection_failures": true}
	derived := map[string]bool{"feed.project_embeddings": true, "feed.tag_embeddings": true, "feed.user_profile_embeddings": true, "feed.embedding_model_state": true, "feed.behavior_signals": true, "feed_behavior_signals": true, "feed_adapter_write_fence": true, "feed_adapter_write_context": true}
	controls := map[string]bool{"feed_runtime_control": true, "feed_schema_compatibility": true, "feed_cleanup_policy": true, "feed_execution_jobs": true, "feed_delivery_heads": true, "feed_delivery_terminals": true, "feed_replay_deliveries": true, "feed_operator_actions": true, "feed_runtime_outbox": true, "feed_rate_windows": true, "feed.runtime_control": true, "feed.schema_compatibility": true, "feed.jobs": true, "feed.event_outbox": true}
	for i := range r.Tables {
		v := &r.Tables[i]
		switch {
		case legacy[v.Table]:
			v.Category = "legacy"
		case derived[v.Table]:
			v.Category = "derived"
		case v.Privacy == "control" || controls[v.Table]:
			v.Category = "control"
		}
	}
	sort.Slice(r.Tables, func(i, j int) bool { return r.Tables[i].Table < r.Tables[j].Table })
	return r, nil
}

func tableRule(profile string, schema int64, name string) (TableRule, bool) {
	r, err := RegistryForSchema(profile, schema)
	if err != nil {
		return TableRule{}, false
	}
	for _, rule := range r.Tables {
		if rule.Table == name {
			return rule, true
		}
	}
	return TableRule{}, false
}
