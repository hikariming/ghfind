package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime/pprof"
	"time"

	"github.com/hikariming/ghfind/internal/feed/auth"
)

// Profile is diagnostic only:100 sequential requests, maximum90seconds. It is
// deliberately separate from the fixed ten-minute acceptance run.
func profile(ctx context.Context, origin string, signer *auth.Verifier, rep *report, out string) error {
	ctx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	f, err := os.OpenFile(filepath.Join(out, "api-cpu.pprof"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := pprof.StartCPUProfile(f); err != nil {
		return err
	}
	defer pprof.StopCPUProfile()
	client := &http.Client{Timeout: 5 * time.Second}
	rep.Scheduled = 100
	rep.Observations = make([]observation, 0, 100)
	startCPU := cpuSeconds()
	for i := 0; i < 100; i++ {
		obs, _ := call(ctx, client, origin, "GET", "/api/feed/projects?limit=20", highUser+1, signer)
		rep.Observations = append(rep.Observations, obs)
		rep.Completed++
		if obs.Status != 200 {
			return errors.New("diagnostic profile request failed")
		}
		rep.Successful++
	}
	rep.CPUSeconds = cpuSeconds() - startCPU
	return nil
}
