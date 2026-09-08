// Fixed allowlist derived from the actual SQLite schema installed by migrations 0001–0007.
// This schema-7 object is immutable format history: do not alter its fingerprint.
export const SCHEMA = {
  id: "cf-d1-feed-7",
  profile: "cf_d1_r2",
  schemaVersion: 7,
  contractVersion: 1,
  migrations: [
    {
      path: "migrations-feed/0001_feed_baseline.sql",
      sha256:
        "482dab46a823d91082f2ea2dc9044950f12e2e075ac05fc5d73e36f4f33ce383",
    },
    {
      path: "migrations-feed/0002_feed_candidate_order.sql",
      sha256:
        "3a05c0acfcce90bd58216d3c83ae635aa20f69ac8b5018c94c1b0c1179916216",
    },
    {
      path: "migrations-feed/0003_feed_runtime_contract.sql",
      sha256:
        "5d867296ce8d44aaac5f8b96e1da5ada81496c4a34266c5c5a110269657a695c",
    },
    {
      path: "migrations-feed/0004_feed_executor_protocol.sql",
      sha256:
        "15c2fed1934254c79ba3772da856944eef9bd083cbad9fe422585aab64a7c0df",
    },
    {
      path: "migrations-feed/0005_feed_cleanup_checkpoints.sql",
      sha256:
        "8873606ca31ffb0d45abdca114aad72878fa82059567ea031e05a18bc6d83116",
    },
    {
      path: "migrations-feed/0006_feed_replay_delivery.sql",
      sha256:
        "00cc4f44efc9ff680aac2a1118d68271263820d38bdd637b5ba45af07194f1a6",
    },
    {
      path: "migrations-feed/0007_feed_schema_compatibility.sql",
      sha256:
        "9b291f0391fb1396cf7825bf87df08665a002d2a5e546c23f4acd903fa5352b6",
    },
  ],
  tables: {
    feed_archive_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        writer_ok: {
          kind: "integer",
          nullable: false,
        },
        profile_ok: {
          kind: "integer",
          nullable: false,
        },
        payload_ok: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_archive_objects: {
      primaryKey: ["object_key"],
      columns: {
        object_key: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        payload_hash: {
          kind: "text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["reserved", "stored", "erased"],
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        erased_at: {
          kind: "unix_ms",
          nullable: true,
        },
        retain_marker_until: {
          kind: "unix_ms",
          nullable: true,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_behavior_signals: {
      primaryKey: ["github_id", "repo_key", "signal"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        signal: {
          kind: "text",
          nullable: false,
          values: ["saved", "outbound", "qualified_dwell"],
        },
        occurred_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_cleanup_jobs: {
      primaryKey: ["deletion_id"],
      columns: {
        deletion_id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_floor: {
          kind: "integer",
          nullable: false,
        },
        requested_at: {
          kind: "unix_ms",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["pending", "leased", "failed", "completed"],
        },
        phase: {
          kind: "text",
          nullable: false,
          values: ["primary", "archive", "semantic", "completed"],
        },
        primary_table: {
          kind: "integer",
          nullable: false,
        },
        archive_cursor: {
          kind: "text",
          nullable: true,
        },
        archive_scan_done: {
          kind: "integer",
          nullable: false,
        },
        failures: {
          kind: "integer",
          nullable: false,
          minimum: 0,
          maximum: 8,
        },
        claims: {
          kind: "integer",
          nullable: false,
        },
        available_at: {
          kind: "unix_ms",
          nullable: false,
        },
        lease_owner: {
          kind: "text",
          nullable: true,
        },
        lease_until: {
          kind: "unix_ms",
          nullable: true,
        },
        last_error: {
          kind: "text",
          nullable: true,
        },
        transition_id: {
          kind: "text",
          nullable: true,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_cleanup_policy: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "integer",
          nullable: false,
        },
        semantic_mode: {
          kind: "text",
          nullable: false,
          values: ["disabled", "required"],
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_command_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        writer_ok: {
          kind: "integer",
          nullable: false,
        },
        profile_ok: {
          kind: "integer",
          nullable: false,
        },
        taxonomy_ok: {
          kind: "integer",
          nullable: false,
        },
        relation_ok: {
          kind: "integer",
          nullable: false,
        },
        payload_ok: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_delivery_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        valid: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_delivery_heads: {
      primaryKey: ["event_id"],
      columns: {
        event_id: {
          kind: "text",
          nullable: false,
        },
        delivery_id: {
          kind: "text",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_delivery_terminals: {
      primaryKey: ["queue", "message_id"],
      columns: {
        queue: {
          kind: "text",
          nullable: false,
        },
        message_id: {
          kind: "text",
          nullable: false,
        },
        delivery_id: {
          kind: "text",
          nullable: false,
        },
        event_id: {
          kind: "text",
          nullable: false,
        },
        envelope_hash: {
          kind: "text",
          nullable: false,
        },
        attempts: {
          kind: "integer",
          nullable: false,
        },
        received_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_events: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        type: {
          kind: "text",
          nullable: false,
          values: [
            "impression",
            "detail_open",
            "dwell",
            "github_outbound",
            "share",
            "save",
            "not_interested",
          ],
        },
        occurred_at: {
          kind: "unix_ms",
          nullable: false,
        },
        duration_ms: {
          kind: "integer",
          nullable: true,
        },
        request_id: {
          kind: "text",
          nullable: false,
        },
        rank: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_execution_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        writer_ok: {
          kind: "integer",
          nullable: false,
        },
        identity_ok: {
          kind: "integer",
          nullable: false,
        },
        lease_ok: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_execution_jobs: {
      primaryKey: ["event_id"],
      columns: {
        event_id: {
          kind: "text",
          nullable: false,
        },
        envelope_json: {
          kind: "json_text",
          nullable: false,
        },
        envelope_hash: {
          kind: "text",
          nullable: false,
        },
        aggregate_key: {
          kind: "text",
          nullable: false,
        },
        source_version: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["pending", "leased", "completed", "dead_letter"],
        },
        attempts: {
          kind: "integer",
          nullable: false,
          minimum: 0,
          maximum: 8,
        },
        available_at: {
          kind: "unix_ms",
          nullable: false,
        },
        lease_owner: {
          kind: "text",
          nullable: true,
        },
        lease_until: {
          kind: "unix_ms",
          nullable: true,
        },
        last_error: {
          kind: "text",
          nullable: true,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
        completed_at: {
          kind: "unix_ms",
          nullable: true,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_operator_actions: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        kind: {
          kind: "text",
          nullable: false,
          values: ["sourceEvent", "deletion"],
        },
        target_id: {
          kind: "text",
          nullable: false,
        },
        operator: {
          kind: "text",
          nullable: false,
        },
        reason: {
          kind: "text",
          nullable: false,
        },
        action: {
          kind: "text",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_operator_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        valid: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_profile_deletions: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_floor: {
          kind: "integer",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["pending", "running", "failed", "completed"],
        },
        primary_complete: {
          kind: "integer",
          nullable: false,
        },
        archive_complete: {
          kind: "integer",
          nullable: false,
        },
        semantic_complete: {
          kind: "integer",
          nullable: false,
        },
        requested_at: {
          kind: "unix_ms",
          nullable: false,
        },
        completed_at: {
          kind: "unix_ms",
          nullable: true,
        },
        last_error: {
          kind: "text",
          nullable: true,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_profile_floors: {
      primaryKey: ["github_id"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_floor: {
          kind: "integer",
          nullable: false,
          minimum: 1,
        },
        deleted_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_project_moderation: {
      primaryKey: ["repo_key"],
      columns: {
        repo_key: {
          kind: "text",
          nullable: false,
        },
        removed: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        allow_high_risk: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        reason: {
          kind: "text",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_project_source_versions: {
      primaryKey: ["repo_key"],
      columns: {
        repo_key: {
          kind: "text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        event_id: {
          kind: "text",
          nullable: false,
        },
        source_version: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        receipt_id: {
          kind: "text",
          nullable: false,
        },
        source_kind: {
          kind: "text",
          nullable: false,
          values: ["app_submission", "agent_submission", "verified_backfill"],
        },
        submitted_at: {
          kind: "unix_ms",
          nullable: false,
        },
        revoked_at: {
          kind: "unix_ms",
          nullable: true,
        },
        item_id: {
          kind: "text",
          nullable: false,
        },
        resolved_commit_sha: {
          kind: "text",
          nullable: false,
        },
        descriptor: {
          kind: "text",
          nullable: false,
        },
        descriptor_hash: {
          kind: "text",
          nullable: false,
        },
        source_hash: {
          kind: "text",
          nullable: false,
        },
        blocked_reason: {
          kind: "text",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [["event_id"]],
    },
    feed_project_tags: {
      primaryKey: ["repo_key", "tag_id"],
      columns: {
        repo_key: {
          kind: "text",
          nullable: false,
        },
        tag_id: {
          kind: "text",
          nullable: false,
        },
        source: {
          kind: "text",
          nullable: false,
          values: ["assessment", "derived", "admin"],
        },
        weight: {
          kind: "number",
          nullable: false,
          minimum: 0,
          maximum: 1,
        },
        confidence: {
          kind: "number",
          nullable: false,
          minimum: 0,
          maximum: 1,
        },
        evidence_json: {
          kind: "json_text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_projection_commands: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        applied: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_projects: {
      primaryKey: ["repo_key"],
      columns: {
        repo_key: {
          kind: "text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        owner_login: {
          kind: "text",
          nullable: false,
        },
        name: {
          kind: "text",
          nullable: false,
        },
        canonical_url: {
          kind: "text",
          nullable: false,
        },
        summary: {
          kind: "text",
          nullable: false,
        },
        language: {
          kind: "text",
          nullable: true,
        },
        topics_json: {
          kind: "json_text",
          nullable: false,
        },
        project_type: {
          kind: "text",
          nullable: false,
        },
        lifecycle: {
          kind: "text",
          nullable: false,
        },
        product_score: {
          kind: "number",
          nullable: false,
        },
        confidence: {
          kind: "number",
          nullable: false,
        },
        verification_level: {
          kind: "text",
          nullable: false,
        },
        exposure_band: {
          kind: "text",
          nullable: false,
        },
        treasure_eligible: {
          kind: "integer",
          nullable: false,
        },
        classic_eligible: {
          kind: "integer",
          nullable: false,
        },
        analyzed_at: {
          kind: "unix_ms",
          nullable: false,
        },
        risks_json: {
          kind: "json_text",
          nullable: false,
        },
        published: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        source_hash: {
          kind: "text",
          nullable: false,
        },
        projected_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_proposal_guards: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        valid: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_rate_windows: {
      primaryKey: ["github_id", "bucket", "window_started"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        bucket: {
          kind: "text",
          nullable: false,
        },
        window_started: {
          kind: "unix_ms",
          nullable: false,
        },
        count: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_replay_deliveries: {
      primaryKey: ["delivery_id"],
      columns: {
        delivery_id: {
          kind: "text",
          nullable: false,
        },
        event_id: {
          kind: "text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: [
            "pending",
            "leased",
            "published",
            "failed",
            "superseded",
            "cancelled",
          ],
        },
        attempts: {
          kind: "integer",
          nullable: false,
          minimum: 0,
          maximum: 8,
        },
        available_at: {
          kind: "unix_ms",
          nullable: false,
        },
        lease_owner: {
          kind: "text",
          nullable: true,
        },
        lease_until: {
          kind: "unix_ms",
          nullable: true,
        },
        last_error: {
          kind: "text",
          nullable: true,
        },
        published_at: {
          kind: "unix_ms",
          nullable: true,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_control: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "integer",
          nullable: false,
        },
        schema_version: {
          kind: "integer",
          nullable: false,
        },
        writer_epoch: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        writes_enabled: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_events: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        request_id: {
          kind: "text",
          nullable: false,
        },
        type: {
          kind: "text",
          nullable: false,
          values: [
            "impression",
            "detail_open",
            "dwell",
            "github_outbound",
            "share",
            "save",
            "unsave",
            "not_interested",
            "undo_not_interested",
          ],
        },
        occurred_at: {
          kind: "unix_ms",
          nullable: false,
        },
        rank: {
          kind: "integer",
          nullable: false,
        },
        duration_ms: {
          kind: "integer",
          nullable: true,
        },
        qualified: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        state_value: {
          kind: "integer",
          nullable: true,
          values: [0, 1],
        },
        payload_hash: {
          kind: "text",
          nullable: false,
        },
        command_id: {
          kind: "text",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_outbox: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        topic: {
          kind: "text",
          nullable: false,
        },
        aggregate_key: {
          kind: "text",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: true,
        },
        payload_json: {
          kind: "json_text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["pending", "leased", "completed", "failed", "dead_letter"],
        },
        attempts: {
          kind: "integer",
          nullable: false,
        },
        available_at: {
          kind: "unix_ms",
          nullable: false,
        },
        lease_until: {
          kind: "unix_ms",
          nullable: true,
        },
        last_error: {
          kind: "text",
          nullable: true,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_requests: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        algorithm_version: {
          kind: "text",
          nullable: false,
        },
        payload_hash: {
          kind: "text",
          nullable: false,
        },
        seed: {
          kind: "text",
          nullable: false,
        },
        candidate_counts_json: {
          kind: "json_text",
          nullable: false,
        },
        degraded_json: {
          kind: "json_text",
          nullable: false,
        },
        duration_ms: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_served_metadata: {
      primaryKey: ["request_id", "repo_key"],
      columns: {
        request_id: {
          kind: "text",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        candidate_sources_json: {
          kind: "json_text",
          nullable: false,
        },
        reason_codes_json: {
          kind: "json_text",
          nullable: false,
        },
        features_json: {
          kind: "json_text",
          nullable: false,
        },
        score: {
          kind: "number",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_runtime_sessions: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        payload_json: {
          kind: "json_text",
          nullable: false,
        },
        payload_hash: {
          kind: "text",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        expires_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_schema_compatibility: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "integer",
          nullable: false,
        },
        min_reader_contract: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        max_reader_contract: {
          kind: "integer",
          nullable: false,
        },
        min_writer_contract: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        max_writer_contract: {
          kind: "integer",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_served_items: {
      primaryKey: ["request_id", "repo_key"],
      columns: {
        request_id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        rank: {
          kind: "integer",
          nullable: false,
        },
        algorithm_version: {
          kind: "text",
          nullable: false,
        },
        source: {
          kind: "text",
          nullable: false,
        },
        propensity: {
          kind: "number",
          nullable: false,
        },
        exploration: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        served_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_submission_provenance: {
      primaryKey: ["repo_key"],
      columns: {
        repo_key: {
          kind: "text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        source_event_id: {
          kind: "text",
          nullable: false,
        },
        source_version: {
          kind: "integer",
          nullable: false,
          exclusiveMinimum: 0,
        },
        evidence_kind: {
          kind: "text",
          nullable: false,
          values: [
            "user_submission",
            "owner_submission",
            "verified_historical",
          ],
        },
        evidence_ref: {
          kind: "text",
          nullable: false,
        },
        submitted_at: {
          kind: "unix_ms",
          nullable: false,
        },
        revoked_at: {
          kind: "unix_ms",
          nullable: true,
        },
      },
      emptyOnly: false,
      uniqueKeys: [["source_event_id"]],
    },
    feed_tag_aliases: {
      primaryKey: ["namespace", "slug"],
      columns: {
        namespace: {
          kind: "text",
          nullable: false,
          values: [
            "domain",
            "use_case",
            "audience",
            "artifact",
            "stack",
            "stage",
          ],
        },
        slug: {
          kind: "text",
          nullable: false,
        },
        canonical_tag_id: {
          kind: "text",
          nullable: false,
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_tag_definitions: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        namespace: {
          kind: "text",
          nullable: false,
          values: [
            "domain",
            "use_case",
            "audience",
            "artifact",
            "stack",
            "stage",
          ],
        },
        slug: {
          kind: "text",
          nullable: false,
        },
        label_zh: {
          kind: "text",
          nullable: false,
        },
        label_en: {
          kind: "text",
          nullable: false,
        },
        description: {
          kind: "text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["canonical", "alias", "proposed", "rejected", "deprecated"],
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [["namespace", "slug"]],
    },
    feed_tag_proposal_commands: {
      primaryKey: ["github_id", "command_id"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        command_id: {
          kind: "text",
          nullable: false,
        },
        proposal_id: {
          kind: "text",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        payload_hash: {
          kind: "text",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_tag_proposals: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        namespace: {
          kind: "text",
          nullable: false,
          values: [
            "domain",
            "use_case",
            "audience",
            "artifact",
            "stack",
            "stage",
          ],
        },
        slug: {
          kind: "text",
          nullable: false,
        },
        label_zh: {
          kind: "text",
          nullable: false,
        },
        label_en: {
          kind: "text",
          nullable: false,
        },
        evidence_json: {
          kind: "json_text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["proposed", "accepted", "rejected"],
        },
        reviewed_by: {
          kind: "text",
          nullable: true,
        },
        review_reason: {
          kind: "text",
          nullable: true,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [["repo_key", "analysis_id", "namespace", "slug"]],
    },
    feed_taxonomy_versions: {
      primaryKey: ["version"],
      columns: {
        version: {
          kind: "integer",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["active", "retired"],
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_user_project_states: {
      primaryKey: ["github_id", "repo_key"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        saved: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        not_interested: {
          kind: "integer",
          nullable: false,
          values: [0, 1],
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_user_proposal_authors: {
      primaryKey: ["proposal_id"],
      columns: {
        proposal_id: {
          kind: "text",
          nullable: false,
        },
        github_id: {
          kind: "integer",
          nullable: false,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        redacted_at: {
          kind: "unix_ms",
          nullable: true,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_user_tag_preferences: {
      primaryKey: ["github_id", "tag_id", "source"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        tag_id: {
          kind: "text",
          nullable: false,
        },
        value: {
          kind: "integer",
          nullable: false,
          values: [-1, 1],
        },
        source: {
          kind: "text",
          nullable: false,
          values: ["explicit", "graph", "behavior"],
        },
        strength: {
          kind: "number",
          nullable: false,
          minimum: 0,
          maximum: 1,
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_user_tag_proposals: {
      primaryKey: ["id"],
      columns: {
        id: {
          kind: "text",
          nullable: false,
        },
        repo_key: {
          kind: "text",
          nullable: false,
        },
        analysis_id: {
          kind: "text",
          nullable: false,
        },
        source: {
          kind: "text",
          nullable: false,
        },
        namespace: {
          kind: "text",
          nullable: false,
          values: [
            "domain",
            "use_case",
            "audience",
            "artifact",
            "stack",
            "stage",
          ],
        },
        slug: {
          kind: "text",
          nullable: false,
        },
        label_zh: {
          kind: "text",
          nullable: false,
        },
        label_en: {
          kind: "text",
          nullable: false,
        },
        evidence_json: {
          kind: "json_text",
          nullable: false,
        },
        status: {
          kind: "text",
          nullable: false,
          values: ["proposed", "mapped", "rejected"],
        },
        reviewed_by: {
          kind: "text",
          nullable: true,
        },
        review_reason: {
          kind: "text",
          nullable: true,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [["repo_key", "analysis_id", "namespace", "slug"]],
    },
    feed_users: {
      primaryKey: ["github_id"],
      columns: {
        github_id: {
          kind: "integer",
          nullable: false,
        },
        login: {
          kind: "text",
          nullable: false,
        },
        avatar_url: {
          kind: "text",
          nullable: true,
        },
        profile_version: {
          kind: "integer",
          nullable: false,
        },
        taxonomy_version: {
          kind: "integer",
          nullable: false,
        },
        created_at: {
          kind: "unix_ms",
          nullable: false,
        },
        updated_at: {
          kind: "unix_ms",
          nullable: false,
        },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
  },
};

// Explicit migration-set registration. 0008 adds an index; 0009 adds governance
// facts and a partial unique index. Neither changes the runtime control value.
// Shared table definitions remain fixed reviewed data, never inferred from SQL.
export const SCHEMA_9 = {
  ...SCHEMA,
  id: "cf-d1-feed-9",
  schemaVersion: 9,
  runtimeControlSchemaVersion: 7,
  migrations: [
    ...SCHEMA.migrations,
    {
      path: "migrations-feed/0008_candidate_recall_indexes.sql",
      sha256:
        "9a544d9915f480562a0e87731ab72135b70492618692eeb444fb20c1a2aec6c1",
    },
    {
      path: "migrations-feed/0009_feed_governance_audit.sql",
      sha256:
        "4ed9ad89d6b752d70725e70f1004a935cbdbab799f85e0c6d60e15cedb84ac84",
    },
  ],
  tables: {
    ...SCHEMA.tables,
    feed_governance_commands: {
      primaryKey: ["command_id"],
      columns: {
        command_id: { kind: "text", nullable: false },
        action: {
          kind: "text",
          nullable: false,
          values: ["create", "map", "reject", "deprecate"],
        },
        writer_epoch: { kind: "integer", nullable: false },
        expected_taxonomy_version: { kind: "integer", nullable: false },
        proposal_kind: {
          kind: "text",
          nullable: true,
          values: ["assessment", "user"],
        },
        proposal_id: { kind: "text", nullable: true },
        repo_key: { kind: "text", nullable: true },
        analysis_id: { kind: "text", nullable: true },
        evidence_hash: { kind: "text", nullable: true },
        canonical_tag_id: { kind: "text", nullable: true },
        assignment_weight: {
          kind: "number",
          nullable: true,
          minimum: 0,
          maximum: 1,
        },
        assignment_confidence: {
          kind: "number",
          nullable: true,
          minimum: 0,
          maximum: 1,
        },
        operator: { kind: "text", nullable: false },
        reason: { kind: "text", nullable: false },
        payload_hash: { kind: "text", nullable: false },
        result_json: { kind: "json_text", nullable: false },
        taxonomy_version: { kind: "integer", nullable: false },
        created_at: { kind: "unix_ms", nullable: false },
      },
      emptyOnly: false,
      uniqueKeys: [],
    },
    feed_governance_guards: {
      primaryKey: ["id"],
      columns: {
        id: { kind: "text", nullable: false },
        identity_ok: { kind: "integer", nullable: false, values: [1] },
        writer_ok: { kind: "integer", nullable: false, values: [1] },
        taxonomy_ok: { kind: "integer", nullable: false, values: [1] },
        proposal_ok: { kind: "integer", nullable: false, values: [1] },
        state_ok: { kind: "integer", nullable: false, values: [1] },
        evidence_ok: { kind: "integer", nullable: false, values: [1] },
        tag_ok: { kind: "integer", nullable: false, values: [1] },
        apply: { kind: "integer", nullable: false, values: [0, 1] },
      },
      emptyOnly: true,
      uniqueKeys: [],
    },
    feed_taxonomy_versions: {
      ...SCHEMA.tables.feed_taxonomy_versions,
      // Retired rows may share their status. Do not model this as UNIQUE(status).
      partialUniqueKeys: [{ columns: ["status"], where: "status='active'" }],
    },
  },
};

function freeze(value) {
  for (const child of Object.values(value))
    if (child && typeof child === "object" && !Object.isFrozen(child))
      freeze(child);
  return Object.freeze(value);
}
export const SCHEMAS = freeze({ 7: SCHEMA, 9: SCHEMA_9 });
export function selectSchema(profile, schemaVersion, contractVersion) {
  if (
    profile !== "cf_d1_r2" ||
    contractVersion !== 1 ||
    !Number.isInteger(schemaVersion) ||
    !Object.hasOwn(SCHEMAS, schemaVersion)
  )
    throw new Error("unsupported_snapshot_schema");
  return SCHEMAS[schemaVersion];
}
