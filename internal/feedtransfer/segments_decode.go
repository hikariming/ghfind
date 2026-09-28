package feedtransfer

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"unicode/utf8"
)

// The atomic receipt may legitimately contain 100k floor objects (over 300k
// JSON nodes). This endpoint alone has a 400k node cap and the same 8MiB body
// bound. v1 and segment/manifest decoders keep their original 200k cap.
func DecodeAtomicCommitReceipt(r io.Reader) (AtomicCommitReceipt, error) {
	var out AtomicCommitReceipt
	data, err := io.ReadAll(io.LimitReader(r, MaxBatchBytes+1))
	if err != nil {
		return out, invalid("read_failed")
	}
	if len(data) > MaxBatchBytes {
		return out, invalid("body_too_large")
	}
	if !utf8.Valid(data) {
		return out, invalid("invalid_json")
	}
	if !pairedSurrogates(data) {
		return out, invalid("invalid_unicode")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	count := 0
	node, err := readAtomicNode(d, 0, &count)
	if err != nil {
		return out, err
	}
	if _, err = d.Token(); err != io.EOF {
		return out, invalid("invalid_json")
	}
	if !shape(node, reflect.TypeOf(out)) {
		return out, invalid("json_shape")
	}
	if json.Unmarshal(data, &out) != nil {
		return out, invalid("json_value")
	}
	if _, err := floorMap(out.After.Floors); err != nil {
		return AtomicCommitReceipt{}, err
	}
	return out, nil
}
func readAtomicNode(d *json.Decoder, depth int, count *int) (any, error) {
	(*count)++
	if depth > 32 || *count > 400000 {
		return nil, invalid("json_complexity")
	}
	t, err := d.Token()
	if err != nil {
		return nil, invalid("invalid_json")
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return t, nil
	}
	switch delim {
	case '{':
		out := map[string]any{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return nil, invalid("invalid_json")
			}
			key, ok := k.(string)
			if !ok {
				return nil, invalid("invalid_json")
			}
			if _, ok = out[key]; ok {
				return nil, invalid("duplicate_json_key")
			}
			v, err := readAtomicNode(d, depth+1, count)
			if err != nil {
				return nil, err
			}
			out[key] = v
		}
		if t, err = d.Token(); err != nil || t != json.Delim('}') {
			return nil, invalid("invalid_json")
		}
		return out, nil
	case '[':
		out := []any{}
		for d.More() {
			v, err := readAtomicNode(d, depth+1, count)
			if err != nil {
				return nil, err
			}
			out = append(out, v)
		}
		if t, err = d.Token(); err != nil || t != json.Delim(']') {
			return nil, invalid("invalid_json")
		}
		return out, nil
	}
	return nil, invalid("invalid_json")
}
