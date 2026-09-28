package feedtransfer

import (
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var columnPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var integerPattern = regexp.MustCompile(`^(0|-?[1-9][0-9]*)$`)

func digest(s string) bool  { return digestPattern.MatchString(s) }
func safe(v int64) bool     { return v >= 0 && v <= MaxSafeInteger }
func positive(v int64) bool { return v > 0 && v <= MaxSafeInteger }
func clean(s string, max int) bool {
	if s == "" || len(s) > max || !utf8.ValidString(s) {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func validIdentity(v Identity) error {
	r, err := RegistryForSchema(v.Profile, v.Schema)
	if err != nil {
		return err
	}
	if !uuidPattern.MatchString(v.ResourceID) || v.Schema != r.Schema || v.WriterContract != r.WriterContract || !positive(v.WriterEpoch) || !positive(v.RouteEpoch) {
		return invalid("identity")
	}
	return nil
}
func ValidateManifest(m Manifest) error {
	if m.Version != Version {
		return invalid("unknown_version")
	}
	if m.Stream != "feed_transaction_journal" {
		return invalid("wrong_stream")
	}
	if !uuidPattern.MatchString(m.MigrationID) || !uuidPattern.MatchString(m.JournalID) {
		return invalid("manifest_identity")
	}
	if err := validIdentity(m.Source); err != nil {
		return err
	}
	if err := validIdentity(m.Target); err != nil {
		return err
	}
	if m.Source.ResourceID == m.Target.ResourceID {
		return invalid("same_resource")
	}
	// Writer epochs belong to each database; route epoch belongs to this promotion.
	if m.Target.RouteEpoch != m.Source.RouteEpoch+1 {
		return invalid("route_epoch")
	}
	if !digest(m.SnapshotSHA256) || !digest(m.ArchiveInventorySHA256) || !safe(m.ArchiveObjects) || !digest(m.DeletionFloorsSHA256) || !safe(m.DeletionFloorActors) || m.DeletionFloorActors > MaxFloorActors || !digest(m.AnchorHash) || !safe(m.FromSequence) || !safe(m.ThroughSequence) || m.ThroughSequence < m.FromSequence {
		return invalid("manifest_range")
	}
	zero := strings.Repeat("0", 64)
	if (m.FromSequence == 0) != (m.AnchorHash == zero) {
		return invalid("anchor")
	}
	r, _ := RegistryForSchema(m.Source.Profile, m.Source.Schema)
	if len(m.Coverage) != len(r.Tables) {
		return invalid("coverage")
	}
	for i, v := range m.Coverage {
		want := r.Tables[i]
		if v.Table != want.Table || v.Mode != want.Mode || v.Category != want.Category || !safe(v.SnapshotRows) || (v.Mode == "empty" && v.SnapshotRows != 0) || (v.Mode == "reinitialize" && v.SnapshotRows != 1) {
			return invalid("coverage")
		}
	}
	return nil
}
func isFloor(table string) bool {
	return table == "feed_profile_floors" || table == "feed.user_deletion_tombstones"
}
func isCommand(table string) bool {
	return table == "feed_tag_proposal_commands" || table == "feed.tag_proposal_commands"
}
func isProposal(table string) bool {
	return table == "feed_user_tag_proposals" || table == "feed.tag_proposals"
}
func isAuthority(table string) bool {
	return table == "feed_runtime_control" || table == "feed_schema_compatibility" || table == "feed.runtime_control" || table == "feed.schema_compatibility"
}

// Images are flat SQL-column objects. SQL JSON/text is preserved as a string;
// decimals and timestamps are schema-mapper strings, never lossy JSON floats.
// This validates the envelope only, NOT column completeness, types or ownership.
func validateImage(b []byte) error {
	if len(b) == 0 || len(b) > MaxImageBytes {
		return invalid("image_size")
	}
	node, err := jsonTree(b)
	if err != nil {
		return err
	}
	m, ok := node.(map[string]any)
	if !ok || len(m) == 0 || len(m) > 512 {
		return invalid("image_shape")
	}
	for k, v := range m {
		if !columnPattern.MatchString(k) {
			return invalid("image_shape")
		}
		switch x := v.(type) {
		case nil, string, bool:
		case json.Number:
			if !integerPattern.MatchString(string(x)) {
				return invalid("image_number")
			}
			n, err := strconv.ParseInt(string(x), 10, 64)
			if err != nil || n < -MaxSafeInteger || n > MaxSafeInteger {
				return invalid("image_number")
			}
		default:
			return invalid("image_shape")
		}
	}
	return nil
}
func validateTransaction(m Manifest, v Transaction) error {
	if !positive(v.Sequence) || v.TransactionID != m.JournalID+":"+strconv.FormatInt(v.Sequence, 10) || !digest(v.PreviousHash) || len(v.Changes) == 0 || len(v.Changes) > MaxChanges {
		return invalid("transaction_shape")
	}
	seen := map[string]bool{}
	images := 0
	for _, c := range v.Changes {
		rule, ok := tableRule(m.Source.Profile, m.Source.Schema, c.Table)
		if !ok || rule.Mode != "capture" {
			return invalid("change_coverage")
		}
		if !clean(c.Key, 1024) {
			return invalid("change_key")
		}
		key := c.Table + "\x00" + c.Key
		if c.Operation == "floor" {
			key += "\x00floor"
		}
		if seen[key] {
			return invalid("duplicate_change")
		}
		seen[key] = true
		if c.Actor != nil && (!positive(c.Actor.GitHubID) || !positive(c.Actor.ProfileVersion)) {
			return invalid("actor_scope")
		}
		if rule.Privacy == "actor" && c.Actor == nil {
			return invalid("actor_scope")
		}
		if rule.Privacy == "shared" && c.Actor != nil {
			return invalid("actor_scope")
		}
		if (isFloor(c.Table) || c.Table == "feed_profile_deletions" || c.Table == "feed_cleanup_jobs" || c.Table == "feed_archive_objects" || c.Table == "feed.archive_objects") && c.Actor == nil {
			return invalid("actor_scope")
		}
		switch c.Operation {
		case "upsert":
			if err := validateImage(c.Image); err != nil {
				return err
			}
			images += len(c.Image)
		case "delete":
			if c.Image != nil || isFloor(c.Table) {
				return invalid("delete_shape")
			}
		case "floor":
			if !isFloor(c.Table) || c.Actor == nil || c.Image != nil {
				return invalid("floor_shape")
			}
		case "erase":
			if !isProposal(c.Table) || c.Actor == nil || c.Image != nil {
				return invalid("erase_shape")
			}
		case "command_tombstone":
			if !isCommand(c.Table) || c.Actor == nil || c.Image != nil {
				return invalid("tombstone_shape")
			}
		default:
			return invalid("unknown_operation")
		}
	}
	if images > MaxImageBytes {
		return invalid("transaction_size")
	}
	// A tombstone table after-image cannot quietly lower a floor. Capture emits
	// a separate, image-free floor record in the same source transaction.
	for _, c := range v.Changes {
		if c.Operation == "upsert" && isFloor(c.Table) {
			found := false
			for _, f := range v.Changes {
				if f.Operation == "floor" && f.Table == c.Table && f.Key == c.Key && *f.Actor == *c.Actor {
					found = true
				}
			}
			if !found {
				return invalid("floor_missing")
			}
		}
	}
	return nil
}

func floorMap(floors []Floor) (map[int64]int64, error) {
	if len(floors) > MaxFloorActors {
		return nil, invalid("floor_limit")
	}
	m := map[int64]int64{}
	for _, f := range floors {
		if !positive(f.GitHubID) || !positive(f.ProfileFloor) {
			return nil, invalid("floor_value")
		}
		if _, ok := m[f.GitHubID]; ok {
			return nil, invalid("duplicate_floor")
		}
		m[f.GitHubID] = f.ProfileFloor
	}
	return m, nil
}
func sortedFloors(m map[int64]int64) []Floor {
	out := make([]Floor, 0, len(m))
	for id, floor := range m {
		out = append(out, Floor{id, floor})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].GitHubID < out[j].GitHubID })
	return out
}

// Begin requires the snapshot's deletion floors plus every newer independently
// verified deletion overlay available before replay. It cannot prove that the
// supplied overlay is complete, and never returns permission to promote.
func Begin(m Manifest, floors []Floor) (Checkpoint, error) {
	h, err := ManifestHash(m)
	if err != nil {
		return Checkpoint{}, err
	}
	f, err := floorMap(floors)
	if err != nil {
		return Checkpoint{}, err
	}
	fh, _ := DeletionFloorsHash(floors)
	if fh != m.DeletionFloorsSHA256 || int64(len(floors)) != m.DeletionFloorActors {
		return Checkpoint{}, invalid("floor_overlay")
	}
	return Checkpoint{ManifestHash: h, Sequence: m.FromSequence, CommitHash: m.AnchorHash, Floors: sortedFloors(f)}, nil
}

// ValidateBatch returns a plan only. Apply the entire batch, receipt and next
// checkpoint in one target transaction, or subdivide solely at source commit
// boundaries with a separate durable per-commit ledger. Never partially ack.
// A duplicate is accepted only with the caller's matching durable receipt.
func ValidateBatch(m Manifest, b Batch, checkpoint Checkpoint, prior *Receipt) (Validation, error) {
	out := Validation{}
	h, err := ManifestHash(m)
	if err != nil {
		return out, err
	}
	if checkpoint.ManifestHash != h || !safe(checkpoint.Sequence) || checkpoint.Sequence < m.FromSequence || checkpoint.Sequence > m.ThroughSequence || !digest(checkpoint.CommitHash) || (checkpoint.Final && checkpoint.Sequence != m.ThroughSequence) {
		return out, invalid("checkpoint")
	}
	if checkpoint.Sequence == m.FromSequence && checkpoint.CommitHash != m.AnchorHash {
		return out, invalid("checkpoint")
	}
	floors, err := floorMap(checkpoint.Floors)
	if err != nil {
		return out, err
	}
	if checkpoint.Sequence == m.FromSequence {
		fh, _ := DeletionFloorsHash(checkpoint.Floors)
		if fh != m.DeletionFloorsSHA256 || int64(len(checkpoint.Floors)) != m.DeletionFloorActors {
			return out, invalid("floor_overlay")
		}
	}
	if b.Version != Version {
		return out, invalid("unknown_version")
	}
	if b.ManifestHash != h || !safe(b.AfterSequence) || b.AfterSequence < m.FromSequence || b.AfterSequence > m.ThroughSequence || !digest(b.PreviousHash) || len(b.Transactions) > MaxTransactions {
		return out, invalid("batch_identity")
	}
	if len(b.Transactions) == 0 && !(b.Final && b.AfterSequence == m.ThroughSequence) {
		return out, invalid("empty_page")
	}
	sequence, previous := b.AfterSequence, b.PreviousHash
	total := 0
	txIDs := map[string]bool{}
	for _, tx := range b.Transactions {
		if sequence == MaxSafeInteger || tx.Sequence != sequence+1 || tx.Sequence > m.ThroughSequence || tx.PreviousHash != previous {
			return out, invalid("transaction_order")
		}
		if txIDs[tx.TransactionID] {
			return out, invalid("duplicate_transaction")
		}
		txIDs[tx.TransactionID] = true
		hash, err := TransactionHash(m, tx)
		if err != nil {
			return out, err
		}
		if tx.Hash != hash {
			return out, invalid("transaction_hash")
		}
		sequence, previous = tx.Sequence, hash
		total += len(tx.Changes)
	}
	if total > MaxBatchChanges {
		return out, invalid("batch_size")
	}
	wire, err := json.Marshal(b)
	if err != nil || len(wire) > MaxBatchBytes {
		return out, invalid("body_too_large")
	}
	bh, err := BatchHash(b)
	if err != nil {
		return out, err
	}
	if b.Hash != bh {
		return out, invalid("batch_hash")
	}
	if b.Final != (sequence == m.ThroughSequence) {
		return out, invalid("final_boundary")
	}
	receipt := Receipt{ManifestHash: h, AfterSequence: b.AfterSequence, ThroughSequence: sequence, BatchHash: bh}
	if prior != nil {
		if *prior != receipt {
			return out, invalid("receipt_conflict")
		}
		if checkpoint.Sequence < sequence || (checkpoint.Sequence == sequence && (checkpoint.CommitHash != previous || checkpoint.Final != b.Final)) {
			return out, invalid("receipt_uncommitted")
		}
		out.Checkpoint = checkpoint
		out.Checkpoint.Floors = sortedFloors(floors)
		out.Receipt = receipt
		out.Duplicate = true
		out.ProtocolComplete = checkpoint.Final
		return out, nil
	}
	if checkpoint.Final || b.AfterSequence != checkpoint.Sequence || b.PreviousHash != checkpoint.CommitHash {
		return out, invalid("page_order")
	}
	for _, tx := range b.Transactions {
		// Merge floors before evaluating ANY write in this transaction, independent
		// of capture's row order. Deleted generations never become live again.
		for _, c := range tx.Changes {
			if c.Operation == "floor" && c.Actor.ProfileVersion > floors[c.Actor.GitHubID] {
				floors[c.Actor.GitHubID] = c.Actor.ProfileVersion
			}
		}
		if len(floors) > MaxFloorActors {
			return Validation{}, invalid("floor_limit")
		}
		for i, c := range tx.Changes {
			action := "apply"
			switch c.Operation {
			case "floor":
				action = "retain_max_floor"
			case "erase", "command_tombstone":
				if c.Actor.ProfileVersion > floors[c.Actor.GitHubID] {
					return Validation{}, invalid("tombstone_without_floor")
				}
				if c.Operation == "erase" {
					action = "erase"
				} else {
					action = "tombstone"
				}
			case "upsert":
				rule, _ := tableRule(m.Source.Profile, m.Source.Schema, c.Table)
				if isAuthority(c.Table) {
					action = "stage_control"
				} else if isFloor(c.Table) {
					action = "merge_floor_control"
				} else if c.Actor != nil && c.Actor.ProfileVersion <= floors[c.Actor.GitHubID] && rule.Privacy != "control" {
					action = "suppress_deleted_generation"
				}
			}
			out.Decisions = append(out.Decisions, Decision{Sequence: tx.Sequence, ChangeIndex: i, Action: action})
		}
	}
	out.Checkpoint = Checkpoint{ManifestHash: h, Sequence: sequence, CommitHash: previous, Floors: sortedFloors(floors), Final: b.Final}
	out.Receipt = receipt
	out.ProtocolComplete = b.Final
	return out, nil
}
