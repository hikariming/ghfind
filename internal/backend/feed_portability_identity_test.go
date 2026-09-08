package backend

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

type portabilityDockerContainer struct {
	ID     string `json:"Id"`
	Name   string
	Image  string
	Path   string
	Config struct {
		Labels map[string]string
		Env    []string
	}
	HostConfig struct {
		NetworkMode  string
		PortBindings map[string][]struct {
			HostIP   string `json:"HostIp"`
			HostPort string
		}
	}
	State struct{ Running bool }
}

func checkPortabilityContainerIdentity(c portabilityConfig, cs []portabilityDockerContainer) error {
	fail := errors.New("owned API/PG namespace, endpoint and database relationship required")
	if len(cs) != 2 {
		return fail
	}
	api, pg := cs[0], cs[1]
	for _, x := range cs {
		if x.Config.Labels["io.ghfind.fixture.owner"] != c.Owner || x.Config.Labels["io.ghfind.fixture.source"] != c.SHA || !x.State.Running {
			return fail
		}
	}
	if api.ID != c.APIContainer || pg.ID != c.PGContainer || api.Image != c.ImageID || api.Path != "/usr/local/bin/feed-api" {
		return fail
	}
	if api.HostConfig.NetworkMode != "container:"+pg.ID && api.HostConfig.NetworkMode != "container:"+strings.TrimPrefix(pg.Name, "/") {
		return fail
	}
	db, _ := url.Parse(c.DSN)
	endpoint, _ := url.Parse(c.Endpoint)
	for port, hostPort := range map[string]string{"5432/tcp": db.Port(), "8080/tcp": endpoint.Port()} {
		bindings := pg.HostConfig.PortBindings[port]
		if len(bindings) != 1 || bindings[0].HostIP != "127.0.0.1" || bindings[0].HostPort != hostPort {
			return fail
		}
	}
	env := map[string]string{}
	for _, v := range api.Config.Env {
		k, val, ok := strings.Cut(v, "=")
		if ok {
			if _, exists := env[k]; exists {
				return fail
			}
			env[k] = val
		}
	}
	inside, err := url.Parse(env["FEED_DATABASE_URL"])
	if err != nil || inside.User == nil || inside.Scheme != "postgres" || inside.Host != "127.0.0.1:5432" || inside.Path != db.Path || inside.User.String() != db.User.String() || inside.RawQuery != db.RawQuery {
		return fail
	}
	if env["FEED_STORE_PROFILE"] != "postgres" || env["FEED_MODE"] != "baseline" || env["FEED_WRITER_EPOCH"] != "1" || env["PORT"] != "8080" || env["FEED_GATEWAY_SECRET"] != strings.Repeat("g", 32) || env["FEED_SIGNING_SECRET"] != strings.Repeat("s", 32) {
		return fail
	}
	return nil
}
func verifyPortabilityDocker(ctx context.Context, c portabilityConfig) error {
	// Read only exact supplied container IDs. Nothing from Config.Env is emitted.
	fail := errors.New("local Docker ownership readback failed")
	if h := os.Getenv("DOCKER_HOST"); h != "" && !strings.HasPrefix(h, "unix://") {
		return fail
	}
	command := func(args ...string) ([]byte, error) {
		one, cancel := context.WithTimeout(ctx, 3e9)
		defer cancel()
		b, err := exec.CommandContext(one, "docker", args...).Output()
		if err != nil || len(b) > 256<<10 {
			return nil, fail
		}
		return b, nil
	}
	b, err := command("context", "show")
	if err != nil {
		return fail
	}
	b, err = command("context", "inspect", strings.TrimSpace(string(b)))
	if err != nil {
		return fail
	}
	var contexts []struct {
		Endpoints map[string]struct{ Host string }
	}
	if json.Unmarshal(b, &contexts) != nil || len(contexts) != 1 || !strings.HasPrefix(contexts[0].Endpoints["docker"].Host, "unix://") {
		return fail
	}
	b, err = command("container", "inspect", c.APIContainer, c.PGContainer)
	if err != nil {
		return fail
	}
	var cs []portabilityDockerContainer
	if json.Unmarshal(b, &cs) != nil {
		return fail
	}
	return checkPortabilityContainerIdentity(c, cs)
}

// Inspect every actual feed base table, requiring zero business rows. Only the
// precise migration-seeded control/taxonomy row counts are exempted. New tables
// automatically require emptiness; no table name can reach a write statement.
func portabilityEmptyTableQuery(table string) (string, int, error) {
	if !regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`).MatchString(table) {
		return "", 0, errors.New("invalid fixture table identifier")
	}
	seeded := map[string]int{"taxonomy_versions": 1, "tag_definitions": 13, "algorithm_configs": 1, "embedding_model_state": 1, "runtime_control": 1, "schema_compatibility": 1, "schema_migrations": 22}
	return `SELECT COUNT(*) FROM feed."` + table + `"`, seeded[table], nil
}
func TestPortabilityRejectsEndpointFromAnotherDatabase(t *testing.T) {
	c := portabilityConfig{DSN: "postgres://u:p@127.0.0.1:55446/feed_test?sslmode=disable&connect_timeout=3", Endpoint: "http://127.0.0.1:58087", Owner: "owner", SHA: "sha", APIContainer: "api", PGContainer: "pg", ImageID: "image"}
	var cs []portabilityDockerContainer
	raw := `[{"Id":"api","Name":"/api","Image":"image","Path":"/usr/local/bin/feed-api","State":{"Running":true},"Config":{"Labels":{"io.ghfind.fixture.owner":"owner","io.ghfind.fixture.source":"sha"},"Env":["FEED_DATABASE_URL=postgres://u:p@127.0.0.1:5432/feed_test?sslmode=disable&connect_timeout=3","FEED_STORE_PROFILE=postgres","FEED_MODE=baseline","FEED_WRITER_EPOCH=1","PORT=8080"]},"HostConfig":{"NetworkMode":"container:pg"}},{"Id":"pg","Name":"/pg","State":{"Running":true},"Config":{"Labels":{"io.ghfind.fixture.owner":"owner","io.ghfind.fixture.source":"sha"}},"HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"55446"}],"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"58087"}]}}}]`
	if json.Unmarshal([]byte(raw), &cs) != nil {
		t.Fatal("fixture")
	}
	cs[0].Config.Env = append(cs[0].Config.Env, "FEED_GATEWAY_SECRET="+strings.Repeat("g", 32), "FEED_SIGNING_SECRET="+strings.Repeat("s", 32))
	if err := checkPortabilityContainerIdentity(c, cs); err != nil {
		t.Fatal(err)
	}
	cs[0].HostConfig.NetworkMode = "container:foreign"
	if checkPortabilityContainerIdentity(c, cs) == nil {
		t.Fatal("foreign DB namespace accepted")
	}
	cs[0].HostConfig.NetworkMode = "container:pg"
	cs[0].Config.Env[0] = "FEED_DATABASE_URL=postgres://u:p@127.0.0.1:5432/foreign_test?sslmode=disable&connect_timeout=3"
	if checkPortabilityContainerIdentity(c, cs) == nil {
		t.Fatal("foreign DB name accepted")
	}
}
func TestPortabilityAllNonSeedTablesMustBeEmpty(t *testing.T) {
	for _, table := range []string{"projects", "tag_aliases", "user_proposal_authors", "tag_proposals", "governance_commands", "archive_objects", "future_business_table"} {
		q, count, err := portabilityEmptyTableQuery(table)
		if err != nil || count != 0 || !strings.HasPrefix(q, "SELECT COUNT(*) FROM feed.") {
			t.Fatalf("unsafe empty table gate %s", table)
		}
	}
	for _, table := range []string{"x;DROP SCHEMA feed", "public.users", `x"--`} {
		if _, _, err := portabilityEmptyTableQuery(table); err == nil {
			t.Fatal("arbitrary SQL accepted")
		}
	}
	_, n, _ := portabilityEmptyTableQuery("tag_definitions")
	if strconv.Itoa(n) != "13" {
		t.Fatal("taxonomy seed count drift")
	}
}
