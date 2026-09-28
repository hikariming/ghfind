package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"runtime"
	"time"
)

type capacityResourceSample struct {
	At                time.Time       `json:"at"`
	OffsetMS          float64         `json:"offsetMs"`
	SampleDurationMS  float64         `json:"sampleDurationMs"`
	ProcessCPUSeconds float64         `json:"processCpuSeconds"`
	HeapBytes         uint64          `json:"heapBytes"`
	Goroutines        int             `json:"goroutines"`
	GCCount           uint32          `json:"gcCount"`
	GCPauseTotalNS    uint64          `json:"gcPauseTotalNs"`
	LastGCUnixNS      uint64          `json:"lastGcUnixNs"`
	PostgreSQL        json.RawMessage `json:"postgresql,omitempty"`
	Error             string          `json:"error,omitempty"`
}

// Synthetic fixture-only diagnostics. No queries, identities or secrets from
// pg_stat_activity are recorded. The observer has its own bounded DB connection
// pool and deadline and never changes request admission or timeout policy.
func sampleCapacityResources(ctx context.Context, db *sql.DB, started time.Time, out *[]capacityResourceSample) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		at := time.Now()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		sample := capacityResourceSample{At: at.UTC(), OffsetMS: float64(at.Sub(started).Microseconds()) / 1000, ProcessCPUSeconds: cpuSeconds(), HeapBytes: memory.HeapAlloc, Goroutines: runtime.NumGoroutine(), GCCount: memory.NumGC, GCPauseTotalNS: memory.PauseTotalNs, LastGCUnixNS: memory.LastGC}
		queryCtx, cancel := context.WithTimeout(ctx, 700*time.Millisecond)
		var raw []byte
		err := db.QueryRowContext(queryCtx, `SELECT jsonb_build_object(
   'activity',COALESCE((SELECT jsonb_agg(x) FROM(SELECT state,wait_event_type,wait_event,COUNT(*) connections FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() GROUP BY state,wait_event_type,wait_event)x),'[]'::jsonb),
   'database',(SELECT jsonb_build_object('commits',xact_commit,'rollbacks',xact_rollback,'blocksRead',blks_read,'blocksHit',blks_hit,'blockReadMs',blk_read_time,'blockWriteMs',blk_write_time,'tempBytes',temp_bytes,'deadlocks',deadlocks) FROM pg_stat_database WHERE datname=current_database()),
   'ungrantedLocks',(SELECT COUNT(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND NOT l.granted))`).Scan(&raw)
		cancel()
		if err != nil {
			sample.Error = "postgres_observer_timeout_or_error"
		} else {
			sample.PostgreSQL = raw
		}
		sample.SampleDurationMS = float64(time.Since(at).Microseconds()) / 1000
		*out = append(*out, sample)
	}
}
