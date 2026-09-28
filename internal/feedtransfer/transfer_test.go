package feedtransfer

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

func manifest(t *testing.T, profile string, through int64, floors []Floor) Manifest {
	t.Helper()
	r, err := RequiredRegistry(profile)
	if err != nil {
		t.Fatal(err)
	}
	other := "postgres"
	if profile == other {
		other = "cf_d1_r2"
	}
	target, _ := RequiredRegistry(other)
	fh, err := DeletionFloorsHash(floors)
	if err != nil {
		t.Fatal(err)
	}
	m := Manifest{Version: 1, Stream: "feed_transaction_journal", MigrationID: "11111111-1111-4111-8111-111111111111", JournalID: "22222222-2222-4222-8222-222222222222", Source: Identity{profile, "33333333-3333-4333-8333-333333333333", r.Schema, 2, 4, 8}, Target: Identity{other, "44444444-4444-4444-8444-444444444444", target.Schema, 2, 1, 9}, SnapshotSHA256: strings.Repeat("a", 64), ArchiveInventorySHA256: strings.Repeat("b", 64), DeletionFloorsSHA256: fh, DeletionFloorActors: int64(len(floors)), FromSequence: 0, ThroughSequence: through, AnchorHash: strings.Repeat("0", 64), Coverage: []Coverage{}}
	for _, v := range r.Tables {
		m.Coverage = append(m.Coverage, Coverage{v.Table, v.Mode, v.Category, func() int64 {
			if v.Mode == "reinitialize" {
				return 1
			}
			return 0
		}()})
	}
	return m
}
func seal(t *testing.T, m Manifest, cp Checkpoint, final bool, sets ...[]Change) Batch {
	t.Helper()
	b := Batch{Version: 1, ManifestHash: cp.ManifestHash, AfterSequence: cp.Sequence, PreviousHash: cp.CommitHash, Transactions: []Transaction{}, Final: final}
	prev := cp.CommitHash
	for i, changes := range sets {
		seq := cp.Sequence + int64(i) + 1
		tx := Transaction{Sequence: seq, TransactionID: fmt.Sprintf("%s:%d", m.JournalID, seq), PreviousHash: prev, Changes: changes}
		h, err := TransactionHash(m, tx)
		if err != nil {
			t.Fatal(err)
		}
		tx.Hash = h
		b.Transactions = append(b.Transactions, tx)
		prev = h
	}
	h, err := BatchHash(b)
	if err != nil {
		t.Fatal(err)
	}
	b.Hash = h
	return b
}
func begin(t *testing.T, m Manifest, floors []Floor) Checkpoint {
	t.Helper()
	c, err := Begin(m, floors)
	if err != nil {
		t.Fatal(err)
	}
	return c
}
func user(profile string, gen int64) Change {
	table := "feed_users"
	if profile == "postgres" {
		table = "feed.users"
	}
	return Change{Table: table, Key: "synthetic:42", Operation: "upsert", Actor: &ActorScope{42, gen}, Image: []byte(fmt.Sprintf(`{"github_id":42,"profile_version":%d,"github_login":"合成 <>&"}`, gen))}
}
func code(t *testing.T, err error, want string) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != want {
		t.Fatalf("expected fixed %s, got %v", want, err)
	}
}
func noPromotion(t *testing.T, v Validation) {
	t.Helper()
	if v.CaptureConnected || v.RowSchemaValidated || v.ArchiveBytesVerified || v.PromotionReady {
		t.Fatal("protocol result claimed unimplemented evidence")
	}
}
func clone[T any](v T) T { b, _ := json.Marshal(v); var out T; _ = json.Unmarshal(b, &out); return out }

func TestBothProfilesOrderedPagesAndDurableDuplicate(t *testing.T) {
	for _, p := range []string{"cf_d1_r2", "postgres"} {
		t.Run(p, func(t *testing.T) {
			m := manifest(t, p, 2, nil)
			cp := begin(t, m, nil)
			b1 := seal(t, m, cp, false, []Change{user(p, 1)})
			v1, err := ValidateBatch(m, b1, cp, nil)
			if err != nil {
				t.Fatal(err)
			}
			noPromotion(t, v1)
			if v1.ProtocolComplete {
				t.Fatal("partial stream completed")
			}
			b2 := seal(t, m, v1.Checkpoint, true, []Change{user(p, 2)})
			v2, err := ValidateBatch(m, b2, v1.Checkpoint, nil)
			if err != nil {
				t.Fatal(err)
			}
			noPromotion(t, v2)
			if !v2.ProtocolComplete || v2.Checkpoint.Sequence != 2 {
				t.Fatal("final checkpoint")
			}
			retry, err := ValidateBatch(m, b1, v2.Checkpoint, &v1.Receipt)
			if err != nil || !retry.Duplicate || len(retry.Decisions) != 0 {
				t.Fatal("durable duplicate was reapplied", err)
			}
			_, err = ValidateBatch(m, b1, v2.Checkpoint, nil)
			code(t, err, "page_order")
			_, err = ValidateBatch(m, b1, cp, &v1.Receipt)
			code(t, err, "receipt_uncommitted")
			changed := clone(b1)
			changed.Transactions[0].Changes[0].Image = []byte(`{"github_id":99}`)
			changed.Transactions[0].Hash, _ = TransactionHash(m, changed.Transactions[0])
			changed.Hash, _ = BatchHash(changed)
			_, err = ValidateBatch(m, changed, v1.Checkpoint, &v1.Receipt)
			code(t, err, "receipt_conflict")
		})
	}
}
func TestCoverageFailsClosedForEveryRelation(t *testing.T) {
	for _, p := range []string{"cf_d1_r2", "postgres"} {
		m := manifest(t, p, 0, nil)
		for i := range m.Coverage {
			bad := clone(m)
			bad.Coverage = append(bad.Coverage[:i], bad.Coverage[i+1:]...)
			code(t, ValidateManifest(bad), "coverage")
		}
		for _, mutate := range []func(*Manifest){func(v *Manifest) { v.Coverage[0] = v.Coverage[1] }, func(v *Manifest) { v.Coverage[0].Category = "fact"; v.Coverage[1].Category = "legacy" }, func(v *Manifest) { v.Coverage[0].Mode = "ignore" }, func(v *Manifest) { v.Coverage[0].SnapshotRows = -1 }} {
			bad := clone(m)
			mutate(&bad)
			code(t, ValidateManifest(bad), "coverage")
		}
	}
	m := manifest(t, "cf_d1_r2", 0, nil)
	for i, v := range m.Coverage {
		if v.Mode == "empty" {
			m.Coverage[i].SnapshotRows = 1
			break
		}
	}
	code(t, ValidateManifest(m), "coverage")
}
func TestIdentityVersionAndEpochFences(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cases := []struct {
		name, want string
		change     func(*Manifest)
	}{
		{"core outbox", "wrong_stream", func(v *Manifest) { v.Stream = "core_feed_outbox_sequence" }},
		{"version", "unknown_version", func(v *Manifest) { v.Version = 2 }},
		{"unknown profile", "unknown_profile", func(v *Manifest) { v.Source.Profile = "turso" }},
		{"schema", "identity", func(v *Manifest) { v.Source.Schema = 10 }},
		{"writer contract", "identity", func(v *Manifest) { v.Target.WriterContract = 1 }},
		{"epoch unsafe", "identity", func(v *Manifest) { v.Target.WriterEpoch = MaxSafeInteger + 1 }},
		{"same resource", "same_resource", func(v *Manifest) { v.Target.ResourceID = v.Source.ResourceID }},
		{"route reused", "route_epoch", func(v *Manifest) { v.Target.RouteEpoch = v.Source.RouteEpoch }},
		{"nil UUID", "manifest_identity", func(v *Manifest) { v.JournalID = "00000000-0000-0000-0000-000000000000" }},
		{"missing anchor", "anchor", func(v *Manifest) { v.FromSequence = 1; v.ThroughSequence = 1 }},
		{"unsafe sequence", "manifest_range", func(v *Manifest) { v.ThroughSequence = MaxSafeInteger + 1 }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) { v := clone(m); tt.change(&v); code(t, ValidateManifest(v), tt.want) })
	}
}
func TestPagesRejectGapsReorderingTamperingAndUnknownChanges(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 2, nil)
	cp := begin(t, m, nil)
	b := seal(t, m, cp, true, []Change{user(m.Source.Profile, 1)}, []Change{user(m.Source.Profile, 2)})
	cases := []struct {
		name, want string
		edit       func(*Batch)
	}{
		{"missing commit", "transaction_order", func(v *Batch) { v.Transactions = v.Transactions[1:] }},
		{"reordered", "transaction_order", func(v *Batch) { v.Transactions[0], v.Transactions[1] = v.Transactions[1], v.Transactions[0] }},
		{"reused transaction ID", "duplicate_transaction", func(v *Batch) { v.Transactions[1].TransactionID = v.Transactions[0].TransactionID }},
		{"unknown table", "change_coverage", func(v *Batch) { v.Transactions[0].Changes[0].Table = "core_feed_outbox" }},
		{"guard mutation", "change_coverage", func(v *Batch) { v.Transactions[0].Changes[0].Table = "feed_command_guards" }},
		{"same key twice", "duplicate_change", func(v *Batch) {
			v.Transactions[0].Changes = append(v.Transactions[0].Changes, v.Transactions[0].Changes[0])
		}},
		{"tamper image", "transaction_hash", func(v *Batch) { v.Transactions[0].Changes[0].Image = []byte(`{"github_id":43}`) }},
		{"wrong target", "batch_identity", func(v *Batch) { v.ManifestHash = strings.Repeat("b", 64) }},
		{"invalid chain", "transaction_order", func(v *Batch) { v.Transactions[1].PreviousHash = strings.Repeat("b", 64) }},
		{"unknown op", "unknown_operation", func(v *Batch) { v.Transactions[0].Changes[0].Operation = "execute_sql" }},
		{"missing actor", "actor_scope", func(v *Batch) { v.Transactions[0].Changes[0].Actor = nil }},
		{"changed final bit", "batch_hash", func(v *Batch) { v.Final = false }},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			v := clone(b)
			tt.edit(&v)
			_, err := ValidateBatch(m, v, cp, nil)
			code(t, err, tt.want)
		})
	}
	early := seal(t, m, cp, true, []Change{user(m.Source.Profile, 1)})
	_, err := ValidateBatch(m, early, cp, nil)
	code(t, err, "final_boundary")
	missingFinal := clone(b)
	missingFinal.Final = false
	missingFinal.Hash, _ = BatchHash(missingFinal)
	_, err = ValidateBatch(m, missingFinal, cp, nil)
	code(t, err, "final_boundary")
	empty := seal(t, m, cp, false)
	_, err = ValidateBatch(m, empty, cp, nil)
	code(t, err, "empty_page")
	terminal := manifest(t, "cf_d1_r2", 0, nil)
	tc := begin(t, terminal, nil)
	v, err := ValidateBatch(terminal, seal(t, terminal, tc, true), tc, nil)
	if err != nil || !v.ProtocolComplete {
		t.Fatal("legitimate empty closed interval", err)
	}
	noPromotion(t, v)
}
func TestDeletionOverlayAndAtomicTombstones(t *testing.T) {
	for _, p := range []string{"cf_d1_r2", "postgres"} {
		t.Run(p, func(t *testing.T) {
			floors := []Floor{{42, 5}}
			m := manifest(t, p, 1, floors)
			cp := begin(t, m, floors)
			floorTable, commandTable, proposalTable := "feed_profile_floors", "feed_tag_proposal_commands", "feed_user_tag_proposals"
			if p == "postgres" {
				floorTable, commandTable, proposalTable = "feed.user_deletion_tombstones", "feed.tag_proposal_commands", "feed.tag_proposals"
			}
			changes := []Change{user(p, 5), user(p, 6), {Table: commandTable, Key: "synthetic-command", Operation: "command_tombstone", Actor: &ActorScope{42, 5}}, {Table: proposalTable, Key: "synthetic-proposal", Operation: "erase", Actor: &ActorScope{42, 5}}, {Table: floorTable, Key: "42", Operation: "floor", Actor: &ActorScope{42, 4}}}
			changes[1].Key = "synthetic:new-generation"
			v, err := ValidateBatch(m, seal(t, m, cp, true, changes), cp, nil)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, d := range v.Decisions {
				got = append(got, d.Action)
			}
			if !reflect.DeepEqual(got, []string{"suppress_deleted_generation", "apply", "tombstone", "erase", "retain_max_floor"}) || v.Checkpoint.Floors[0].ProfileFloor != 5 {
				t.Fatal("floor regression", got)
			}
			noPromotion(t, v)
			_, err = Begin(m, nil)
			code(t, err, "floor_overlay")
			fresh := manifest(t, p, 1, nil)
			fc := begin(t, fresh, nil)
			atomic := []Change{user(p, 5), {Table: floorTable, Key: "42", Operation: "floor", Actor: &ActorScope{42, 5}}}
			v, err = ValidateBatch(fresh, seal(t, fresh, fc, true, atomic), fc, nil)
			if err != nil || v.Decisions[0].Action != "suppress_deleted_generation" {
				t.Fatal("row order resurrected", err)
			}
			orphan := []Change{changes[2]}
			_, err = ValidateBatch(fresh, seal(t, fresh, fc, true, orphan), fc, nil)
			code(t, err, "tombstone_without_floor")
			withBody := changes[2]
			withBody.Image = []byte(`{"proposal_id":"private"}`)
			_, err = TransactionHash(m, Transaction{Sequence: 1, TransactionID: m.JournalID + ":1", PreviousHash: cp.CommitHash, Changes: []Change{withBody}})
			code(t, err, "tombstone_shape")
			if cp.Floors[0].ProfileFloor != 5 || len(fc.Floors) != 0 {
				t.Fatal("input checkpoint mutated")
			}
		})
	}
}
func TestImageNumbersAndPrivateErrors(t *testing.T) {
	for _, image := range []string{`{"n":9007199254740992}`, `{"n":1.5}`, `{"n":1e1}`, `{"n":-0}`, `{"n":1.0}`} {
		code(t, validateImage([]byte(image)), "image_number")
	}
	for _, image := range []string{`{"n":9007199254740991}`, `{"n":-9007199254740991}`, `{"weight":"0.78","at":"2026-09-09T00:00:00.000Z","null":null,"ok":true}`} {
		if err := validateImage([]byte(image)); err != nil {
			t.Fatal(err)
		}
	}
	code(t, validateImage([]byte(`{"secret":"do-not-log","secret":1}`)), "duplicate_json_key")
	code(t, validateImage([]byte(`{"nested":{"secret":"do-not-log"}}`)), "image_shape")
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	b := seal(t, m, cp, true, []Change{user(m.Source.Profile, 1)})
	b.Transactions[0].Changes[0].Image = []byte(`{"secret":"do-not-log"}`)
	_, err := ValidateBatch(m, b, cp, nil)
	if err == nil || strings.Contains(err.Error(), "do-not-log") {
		t.Fatal("raw row leaked")
	}
}
func TestStrictDecodeAndStreamingLimit(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	b := seal(t, m, cp, true, []Change{user(m.Source.Profile, 1)})
	wire, _ := json.Marshal(b)
	if _, err := DecodeBatch(bytes.NewReader(wire)); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ wire, want string }{
		{strings.Replace(string(wire), `"version":1`, `"version":1,"version":1`, 1), "duplicate_json_key"},
		{strings.Replace(string(wire), `"version":1`, `"Version":1`, 1), "json_shape"},
		{strings.Replace(string(wire), `"final":true,`, "", 1), "json_shape"},
		{strings.Replace(string(wire), `"version":1`, `"version":null`, 1), "json_shape"},
		{strings.Replace(string(wire), `"version":1`, `"version":1.0`, 1), "json_shape"},
		{strings.Replace(string(wire), `"version":1`, `"version":1,"extra":1`, 1), "json_shape"},
		{string(wire) + `{}`, "invalid_json"},
		{strings.Replace(string(wire), `"githubId":42`, `"githubId":42,"github\u0049d":42`, 1), "duplicate_json_key"},
		{strings.Replace(string(wire), `"image":"`, `"image":"!`, 1), "json_value"},
	}
	for i, tt := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) { _, err := DecodeBatch(strings.NewReader(tt.wire)); code(t, err, tt.want) })
	}
	reader := &countingReader{remaining: MaxBatchBytes + 100}
	_, err := DecodeBatch(reader)
	code(t, err, "body_too_large")
	if reader.read != MaxBatchBytes+1 {
		t.Fatal("did not bound streaming read", reader.read)
	}
	bad := append([]byte(`{"x":"`), 255)
	bad = append(bad, []byte(`"}`)...)
	_, err = DecodeBatch(bytes.NewReader(bad))
	code(t, err, "invalid_json")
}

type countingReader struct{ remaining, read int }

func (r *countingReader) Read(p []byte) (int, error) {
	if r.remaining == 0 {
		return 0, io.EOF
	}
	n := len(p)
	if n > r.remaining {
		n = r.remaining
	}
	for i := 0; i < n; i++ {
		p[i] = ' '
	}
	r.remaining -= n
	r.read += n
	return n, nil
}

func TestCoverageTracksPhysicalSchemasWithoutClaimingMapping(t *testing.T) {
	// This is a local SQLite inventory check, not a Workers/D1 transaction test.
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	files, err := filepath.Glob("../../migrations-feed/*.sql")
	if err != nil || len(files) != 12 {
		t.Fatal("register the new D1 schema before use")
	}
	for _, path := range files {
		sqlBytes, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(sqlBytes)); err != nil {
			t.Fatalf("local inventory migration %s: %v", filepath.Base(path), err)
		}
	}
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'feed_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var cf []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		cf = append(cf, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	assertNames := func(profile string, names []string) {
		r, _ := RequiredRegistry(profile)
		var want []string
		for _, v := range r.Tables {
			want = append(want, v.Table)
		}
		sort.Strings(names)
		if !reflect.DeepEqual(names, want) {
			t.Fatalf("%s inventory drift: actual %v registry %v", profile, names, want)
		}
	}
	assertNames("cf_d1_r2", cf)
	if len(cf) != 47 {
		t.Fatal("snapshot12 inventory")
	}
	// PG check inventories declarations only; actual PG migration/row semantics
	// remain the existing mandatory database suite, not this protocol test.
	files, err = filepath.Glob("../feedmigration/migrations/*.sql")
	if err != nil || len(files) != 22 {
		t.Fatal("register the new PG schema before use")
	}
	create := regexp.MustCompile(`(?i)CREATE TABLE (?:IF NOT EXISTS )?(feed\.[a-z_]+)`)
	var pg []string
	for _, path := range files {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range create.FindAllStringSubmatch(string(b), -1) {
			pg = append(pg, m[1])
		}
	}
	assertNames("postgres", pg)
	r, _ := RequiredRegistry("postgres")
	legacy := map[string]bool{}
	for _, v := range r.Tables {
		if v.Category == "legacy" {
			legacy[v.Table] = true
		}
	}
	if !legacy["feed.gorse_shadow_results"] {
		t.Fatal("legacy was called primary fact")
	}
}

func TestInitialCheckpointCannotBypassDeletionOverlay(t *testing.T) {
	floors := []Floor{{42, 5}}
	m := manifest(t, "cf_d1_r2", 1, floors)
	cp := begin(t, m, floors)
	b := seal(t, m, cp, true, []Change{user(m.Source.Profile, 5)})
	for _, f := range [][]Floor{nil, {{42, 4}}, {{43, 5}}} {
		bad := clone(cp)
		bad.Floors = f
		_, err := ValidateBatch(m, b, bad, nil)
		code(t, err, "floor_overlay")
	}
}
func TestUnicodeSurrogatesAcrossEnvelopeAndImages(t *testing.T) {
	for _, raw := range []string{`{"\ud800":1}`, `{"n":"\udc00"}`, `{"n":"\ud800x"}`, `{"n":"\ud800\ud800"}`, `{"n":"\ud800\\udc00"}`} {
		_, err := jsonTree([]byte(raw))
		code(t, err, "invalid_unicode")
		code(t, validateImage([]byte(raw)), "invalid_unicode")
	}
	for _, raw := range []string{`{"n":"\ud83d\ude00"}`, `{"n":"😀"}`, `{"n":"\\ud800"}`, `{"n":"\u2028"}`} {
		if _, err := jsonTree([]byte(raw)); err != nil {
			t.Fatal(err)
		}
		if err := validateImage([]byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
	m := manifest(t, "cf_d1_r2", 0, nil)
	wire, _ := json.Marshal(m)
	bad := strings.Replace(string(wire), `"stream":`, `"\ud800":null,"stream":`, 1)
	_, err := DecodeManifest(strings.NewReader(bad))
	code(t, err, "invalid_unicode")
}
func TestSharedGoldenFixture(t *testing.T) {
	var f struct {
		Synthetic       bool              `json:"synthetic"`
		Manifest        json.RawMessage   `json:"manifest"`
		ManifestHash    string            `json:"manifestHash"`
		Floors          []Floor           `json:"floors"`
		Batches         []json.RawMessage `json:"batches"`
		ExpectedActions [][]string        `json:"expectedActions"`
	}
	wire, err := os.ReadFile("testdata/transfer-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(wire, &f); err != nil {
		t.Fatal(err)
	}
	if !f.Synthetic {
		t.Fatal("fixture must be synthetic")
	}
	m, err := DecodeManifest(bytes.NewReader(f.Manifest))
	if err != nil {
		t.Fatal(err)
	}
	mh, err := ManifestHash(m)
	if err != nil || mh != f.ManifestHash {
		t.Fatal("independent manifest hash mismatch", err)
	}
	cp := begin(t, m, f.Floors)
	for i, wire := range f.Batches {
		b, err := DecodeBatch(bytes.NewReader(wire))
		if err != nil {
			t.Fatal(err)
		}
		v, err := ValidateBatch(m, b, cp, nil)
		if err != nil {
			t.Fatalf("golden batch %d: %v", i, err)
		}
		var actions []string
		for _, d := range v.Decisions {
			actions = append(actions, d.Action)
		}
		if !reflect.DeepEqual(actions, f.ExpectedActions[i]) {
			t.Fatal("golden deletion decisions")
		}
		noPromotion(t, v)
		cp = v.Checkpoint
	}
	if !cp.Final {
		t.Fatal("golden interval not closed")
	}
}
func TestBoundedTransactionsAndControlStaging(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	cp := begin(t, m, nil)
	authority := Change{Table: "feed_runtime_control", Key: "1", Operation: "upsert", Image: []byte(`{"writer_epoch":99,"writes_enabled":1}`)}
	v, err := ValidateBatch(m, seal(t, m, cp, true, []Change{authority}), cp, nil)
	if err != nil || v.Decisions[0].Action != "stage_control" {
		t.Fatal("source routing controls could activate target", err)
	}
	tx := Transaction{Sequence: 1, TransactionID: m.JournalID + ":1", PreviousHash: cp.CommitHash, Changes: make([]Change, MaxChanges+1)}
	_, err = TransactionHash(m, tx)
	code(t, err, "transaction_shape")
	big := user(m.Source.Profile, 1)
	big.Image = []byte(`{"body":"` + strings.Repeat("x", MaxImageBytes) + `"}`)
	tx.Changes = []Change{big}
	_, err = TransactionHash(m, tx)
	code(t, err, "image_size")
	half := user(m.Source.Profile, 1)
	half.Image = []byte(`{"body":"` + strings.Repeat("x", MaxImageBytes/2) + `"}`)
	other := clone(half)
	other.Key = "other"
	tx.Changes = []Change{half, other}
	_, err = TransactionHash(m, tx)
	code(t, err, "transaction_size")
	floor := Change{Table: "feed_profile_floors", Key: "42", Operation: "upsert", Actor: &ActorScope{42, 5}, Image: []byte(`{"github_id":42,"profile_floor":5}`)}
	tx.Changes = []Change{floor}
	_, err = TransactionHash(m, tx)
	code(t, err, "floor_missing")
	tx.Changes[0].Operation = "delete"
	tx.Changes[0].Image = nil
	_, err = TransactionHash(m, tx)
	code(t, err, "delete_shape")
}

func TestSharedUnicodeFixture(t *testing.T) {
	var cases []struct {
		JSON  string  `json:"json"`
		Error *string `json:"error"`
	}
	b, err := os.ReadFile("testdata/unicode-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for i, c := range cases {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			_, err := jsonTree([]byte(c.JSON))
			if c.Error == nil {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				code(t, err, *c.Error)
			}
		})
	}
}

func TestAggregateBoundsAndCanonicalIntegerTokens(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 33, nil)
	cp := begin(t, m, nil)
	sets := make([][]Change, 33)
	for i := range sets {
		sets[i] = []Change{user(m.Source.Profile, 1)}
	}
	// Hashing rejects oversized pages even before their final validation.
	b := Batch{Version: 1, ManifestHash: cp.ManifestHash, AfterSequence: 0, PreviousHash: cp.CommitHash, Transactions: make([]Transaction, MaxTransactions+1)}
	_, err := BatchHash(b)
	code(t, err, "batch_shape")
	m.ThroughSequence = 5
	cp = begin(t, m, nil)
	sets = make([][]Change, 5)
	for i := range sets {
		for j := 0; j < 512; j++ {
			c := user(m.Source.Profile, 1)
			c.Key = fmt.Sprintf("synthetic:%d", j)
			sets[i] = append(sets[i], c)
		}
	}
	b = seal(t, m, cp, true, sets...)
	_, err = ValidateBatch(m, b, cp, nil)
	code(t, err, "batch_size")
	wire, _ := json.Marshal(m)
	for _, token := range []string{"-0", "0.0", "0e0"} {
		raw := strings.Replace(string(wire), `"fromSequence":0`, `"fromSequence":`+token, 1)
		_, err := DecodeManifest(strings.NewReader(raw))
		code(t, err, "json_shape")
	}
	_, err = Begin(m, []Floor{{42, 5}, {42, 6}})
	code(t, err, "duplicate_floor")
}

func TestAdapterAuthorizationControlsNeverTransfer(t *testing.T) {
	m := manifest(t, "cf_d1_r2", 1, nil)
	for _, table := range []string{"feed_adapter_write_context", "feed_adapter_write_fence"} {
		rule, ok := tableRule(m.Source.Profile, m.Source.Schema, table)
		if !ok || rule.Category != "derived" || rule.Mode == "capture" {
			t.Fatalf("unsafe adapter metadata rule: %+v", rule)
		}
		cp := begin(t, m, nil)
		tx := Transaction{Sequence: 1, TransactionID: m.JournalID + ":1", PreviousHash: cp.CommitHash, Changes: []Change{{Table: table, Key: "1", Operation: "upsert", Image: []byte(`{"id":1,"enabled":0}`)}}}
		_, err := TransactionHash(m, tx)
		code(t, err, "change_coverage")
		_, _, err = SegmentHash(m, segmentEnvelope(m, 0, 0, emptyChain(), []SegmentChange{{Row: tx.Changes[0]}}))
		code(t, err, "change_coverage")
		for _, count := range []int64{0, 1, 2} {
			bad := clone(m)
			for i := range bad.Coverage {
				if bad.Coverage[i].Table == table {
					bad.Coverage[i].SnapshotRows = count
				}
			}
			valid := table == "feed_adapter_write_context" && count == 0 || table == "feed_adapter_write_fence" && count == 1
			if err := ValidateManifest(bad); valid {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				code(t, err, "coverage")
			}
		}
	}
	old, err := RegistryForSchema("cf_d1_r2", 11)
	if err != nil || old.Schema != 11 || len(old.Tables) != 45 {
		t.Fatal("historical registry changed", err)
	}
	if _, ok := tableRule("cf_d1_r2", 11, "feed_adapter_write_context"); ok {
		t.Fatal("schema11 accepted schema12 context")
	}
}
