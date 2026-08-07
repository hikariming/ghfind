// Command ghfind-upstash-mock is a staging-only stand-in for the Upstash REST
// API. It serves the small command subset the Go backend actually issues:
// PING, SET, GET, DEL, EXPIRE, INCR and the two fixed EVAL sliding-window
// scripts. State lives in memory; nothing here is used in production.
package mockupstash

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type kvEntry struct {
	value     string
	expiresAt int64
}

type zsetEntry struct {
	members   map[string]float64
	expiresAt int64
}

type Store struct {
	mu    sync.Mutex
	kv    map[string]*kvEntry
	zsets map[string]*zsetEntry
	nowMs func() int64
}

func New() *Store {
	return &Store{kv: map[string]*kvEntry{}, zsets: map[string]*zsetEntry{}, nowMs: func() int64 { return time.Now().UnixMilli() }}
}

func (s *Store) live(key string) *kvEntry {
	entry, ok := s.kv[key]
	if !ok {
		return nil
	}
	if entry.expiresAt != 0 && s.nowMs() >= entry.expiresAt {
		delete(s.kv, key)
		return nil
	}
	return entry
}

func (s *Store) liveZset(key string) *zsetEntry {
	entry, ok := s.zsets[key]
	if !ok {
		return nil
	}
	if entry.expiresAt != 0 && s.nowMs() >= entry.expiresAt {
		delete(s.zsets, key)
		return nil
	}
	return entry
}

const (
	slidingWindowMarker = "ZREMRANGEBYSCORE"
	legacyWindowMarker  = "INCRBY"
)

func (s *Store) RunCommand(command []any) (any, error) {
	if len(command) == 0 {
		return nil, fmt.Errorf("empty command")
	}
	name := strings.ToUpper(strings.TrimSpace(str(command[0])))
	switch name {
	case "PING":
		return "PONG", nil
	case "SET":
		return s.cmdSet(command)
	case "GET":
		return s.cmdGet(command)
	case "DEL":
		return s.cmdDel(command)
	case "EXPIRE":
		return s.cmdExpire(command)
	case "INCR":
		return s.cmdIncr(command)
	case "EVAL":
		return s.cmdEval(command)
	default:
		return nil, fmt.Errorf("unsupported command %q", name)
	}
}

func str(v any) string {
	switch value := v.(type) {
	case string:
		return value
	default:
		return fmt.Sprintf("%v", value)
	}
}

func int64Of(v any) (int64, error) {
	switch value := v.(type) {
	case float64:
		return int64(value), nil
	case string:
		return strconv.ParseInt(value, 10, 64)
	case json.Number:
		return value.Int64()
	default:
		return 0, fmt.Errorf("not a number: %v", v)
	}
}

func argAt(command []any, index int) any {
	if index >= len(command) {
		return nil
	}
	return command[index]
}

func (s *Store) cmdSet(command []any) (any, error) {
	if len(command) < 3 {
		return nil, fmt.Errorf("SET needs key and value")
	}
	key, value := str(command[1]), str(command[2])
	entry := &kvEntry{value: value}
	for index := 3; index < len(command); index++ {
		flag := strings.ToUpper(str(command[index]))
		switch flag {
		case "EX", "PX":
			amount, err := int64Of(argAt(command, index+1))
			if err != nil {
				return nil, fmt.Errorf("bad %s amount: %v", flag, err)
			}
			if flag == "EX" {
				amount *= 1000
			}
			entry.expiresAt = s.nowMs() + amount
			index++
		case "NX":
			if s.live(key) != nil {
				return nil, nil
			}
		case "XX":
			if s.live(key) == nil {
				return nil, nil
			}
		default:
			return nil, fmt.Errorf("unsupported SET option %q", flag)
		}
	}
	s.kv[key] = entry
	return "OK", nil
}

func (s *Store) cmdGet(command []any) (any, error) {
	if len(command) < 2 {
		return nil, fmt.Errorf("GET needs a key")
	}
	entry := s.live(str(command[1]))
	if entry == nil {
		return nil, nil
	}
	return entry.value, nil
}

func (s *Store) cmdDel(command []any) (any, error) {
	deleted := int64(0)
	for index := 1; index < len(command); index++ {
		key := str(command[index])
		if s.live(key) != nil {
			delete(s.kv, key)
			deleted++
		}
		if s.liveZset(key) != nil {
			delete(s.zsets, key)
			deleted++
		}
	}
	return deleted, nil
}

func (s *Store) cmdExpire(command []any) (any, error) {
	if len(command) < 3 {
		return nil, fmt.Errorf("EXPIRE needs key and seconds")
	}
	seconds, err := int64Of(command[2])
	if err != nil {
		return nil, fmt.Errorf("bad EXPIRE amount: %v", err)
	}
	key := str(command[1])
	if entry := s.live(key); entry != nil {
		entry.expiresAt = s.nowMs() + seconds*1000
		return int64(1), nil
	}
	if entry := s.liveZset(key); entry != nil {
		entry.expiresAt = s.nowMs() + seconds*1000
		return int64(1), nil
	}
	return int64(0), nil
}

func (s *Store) cmdIncr(command []any) (any, error) {
	if len(command) < 2 {
		return nil, fmt.Errorf("INCR needs a key")
	}
	key := str(command[1])
	entry := s.live(key)
	current := int64(0)
	if entry != nil {
		parsed, err := strconv.ParseInt(entry.value, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("INCR against non-integer: %v", err)
		}
		current = parsed
	}
	s.kv[key] = &kvEntry{value: strconv.FormatInt(current+1, 10)}
	return current + 1, nil
}

func (s *Store) cmdEval(command []any) (any, error) {
	if len(command) < 3 {
		return nil, fmt.Errorf("EVAL needs script and numkeys")
	}
	script := str(command[1])
	numKeys, err := int64Of(command[2])
	if err != nil || numKeys < 0 {
		return nil, fmt.Errorf("bad EVAL numkeys")
	}
	keys := make([]string, 0, numKeys)
	for index := int64(0); index < numKeys; index++ {
		keys = append(keys, str(argAt(command, int(3+index))))
	}
	argv := make([]any, 0)
	for index := 3 + int(numKeys); index < len(command); index++ {
		argv = append(argv, command[index])
	}
	switch {
	case strings.Contains(script, slidingWindowMarker):
		return s.evalSlidingWindow(keys, argv)
	case strings.Contains(script, legacyWindowMarker):
		return s.evalLegacyWindow(keys, argv)
	default:
		return nil, fmt.Errorf("unknown EVAL script")
	}
}

// evalSlidingWindow and evalLegacyWindow must be called with s.mu held; the
// HTTP handler takes the lock around runCommand.
func (s *Store) evalSlidingWindow(keys []string, argv []any) (any, error) {
	now, err := int64Of(argAt(argv, 0))
	if err != nil {
		return nil, err
	}
	window, err := int64Of(argAt(argv, 1))
	if err != nil {
		return nil, err
	}
	limit, err := int64Of(argAt(argv, 2))
	if err != nil {
		return nil, err
	}
	member := str(argAt(argv, 3))
	key := keys[0]

	zset := s.liveZset(key)
	if zset == nil {
		zset = &zsetEntry{members: map[string]float64{}, expiresAt: s.nowMs() + window}
		s.zsets[key] = zset
	}
	for existing, score := range zset.members {
		if score < float64(now-window) {
			delete(zset.members, existing)
		}
	}
	count := int64(len(zset.members))
	if count >= limit {
		oldest := zset.members[firstMember(zset.members)]
		return []any{float64(0), float64(0), oldest + float64(window)}, nil
	}
	zset.members[member] = float64(now)
	zset.expiresAt = s.nowMs() + window
	return []any{float64(1), float64(limit - count - 1), float64(now + window)}, nil
}

func firstMember(members map[string]float64) string {
	first, oldest := "", float64(0)
	for member, score := range members {
		if first == "" || score < oldest {
			first, oldest = member, score
		}
	}
	return first
}

func (s *Store) evalLegacyWindow(keys []string, argv []any) (any, error) {
	tokens, err := int64Of(argAt(argv, 0))
	if err != nil {
		return nil, err
	}
	now, err := int64Of(argAt(argv, 1))
	if err != nil {
		return nil, err
	}
	window, err := int64Of(argAt(argv, 2))
	if err != nil {
		return nil, err
	}
	incrementBy, err := int64Of(argAt(argv, 3))
	if err != nil {
		return nil, err
	}
	currentKey, previousKey, dynamicLimitKey := "", "", ""
	if len(keys) > 0 {
		currentKey = keys[0]
	}
	if len(keys) > 1 {
		previousKey = keys[1]
	}
	if len(keys) > 2 {
		dynamicLimitKey = keys[2]
	}

	effectiveLimit := tokens
	if dynamicLimitKey != "" {
		if dynamic := s.live(dynamicLimitKey); dynamic != nil {
			if parsed, err := strconv.ParseInt(dynamic.value, 10, 64); err == nil {
				effectiveLimit = parsed
			}
		}
	}
	current := int64(0)
	if entry := s.live(currentKey); entry != nil {
		if parsed, err := strconv.ParseInt(entry.value, 10, 64); err == nil {
			current = parsed
		}
	}
	previous := int64(0)
	if entry := s.live(previousKey); entry != nil {
		if parsed, err := strconv.ParseInt(entry.value, 10, 64); err == nil {
			previous = parsed
		}
	}
	percentageInCurrent := float64(now%window) / float64(window)
	previous = int64(float64(1-percentageInCurrent) * float64(previous))
	if incrementBy > 0 && previous+current >= effectiveLimit {
		return []any{float64(-1), float64(effectiveLimit)}, nil
	}
	newValue := current + incrementBy
	s.kv[currentKey] = &kvEntry{value: strconv.FormatInt(newValue, 10)}
	if newValue == incrementBy {
		s.kv[currentKey].expiresAt = s.nowMs() + window*2 + 1000
	}
	return []any{float64(effectiveLimit - (newValue + previous)), float64(effectiveLimit)}, nil
}

// HandleHTTP serves the Upstash REST command envelope. The Go backend posts a
// single command as a flat JSON array (["SET", key, value]); the Upstash
// pipeline form ([[...],[...]]) is also accepted for compatibility, running
// the first command only.
func (s *Store) HandleHTTP(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var raw []any
	if err := json.NewDecoder(request.Body).Decode(&raw); err != nil {
		http.Error(w, "invalid command array", http.StatusBadRequest)
		return
	}
	if len(raw) == 0 {
		http.Error(w, "empty command array", http.StatusBadRequest)
		return
	}
	var command []any
	if nested, ok := raw[0].([]any); ok {
		command = nested
	} else {
		command = raw
	}
	if len(command) == 0 {
		http.Error(w, "empty command", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	result, err := s.RunCommand(command)
	s.mu.Unlock()
	if err != nil {
		writeEnvelope(w, http.StatusBadRequest, nil, err.Error())
		return
	}
	writeEnvelope(w, http.StatusOK, result, "")
}

func writeEnvelope(w http.ResponseWriter, status int, result any, errorText string) {
	envelope := map[string]any{}
	if errorText != "" {
		envelope["error"] = errorText
	} else {
		envelope["result"] = result
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope)
}
