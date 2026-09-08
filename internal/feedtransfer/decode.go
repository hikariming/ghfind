package feedtransfer

import (
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"strconv"
	"strings"
	"unicode/utf8"
)

// DecodeManifest and DecodeBatch require every DTO field, including explicit
// null actor/image values. JSON member names are case-sensitive. Values never
// appear in returned errors. The caller must separately bound transport time.
func DecodeManifest(r io.Reader) (Manifest, error) {
	var v Manifest
	err := decode(r, &v, 256<<10)
	return v, err
}
func DecodeBatch(r io.Reader) (Batch, error) {
	var v Batch
	err := decode(r, &v, MaxBatchBytes)
	return v, err
}

func decode(r io.Reader, dst any, limit int64) error {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err != nil {
		return invalid("read_failed")
	}
	if int64(len(data)) > limit {
		return invalid("body_too_large")
	}
	node, err := jsonTree(data)
	if err != nil {
		return err
	}
	if !shape(node, reflect.TypeOf(dst).Elem()) {
		return invalid("json_shape")
	}
	if err := json.Unmarshal(data, dst); err != nil {
		return invalid("json_value")
	}
	return nil
}

func jsonTree(data []byte) (any, error) {
	if !utf8.Valid(data) {
		return nil, invalid("invalid_json")
	}
	if !pairedSurrogates(data) {
		return nil, invalid("invalid_unicode")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	count := 0
	v, err := readNode(d, 0, &count)
	if err != nil {
		return nil, err
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, invalid("invalid_json")
	}
	return v, nil
}
func readNode(d *json.Decoder, depth int, count *int) (any, error) {
	(*count)++
	if depth > 32 || *count > 200000 {
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
			v, err := readNode(d, depth+1, count)
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
			v, err := readNode(d, depth+1, count)
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
func shape(v any, t reflect.Type) bool {
	if t.Kind() == reflect.Pointer {
		return v == nil || shape(v, t.Elem())
	}
	if t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.Uint8 {
		_, ok := v.(string)
		return ok || v == nil
	}
	switch t.Kind() {
	case reflect.Struct:
		m, ok := v.(map[string]any)
		if !ok || len(m) != t.NumField() {
			return false
		}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			key := strings.Split(f.Tag.Get("json"), ",")[0]
			x, ok := m[key]
			if !ok || !shape(x, f.Type) {
				return false
			}
		}
		return true
	case reflect.Slice:
		a, ok := v.([]any)
		if !ok {
			return false
		}
		for _, x := range a {
			if !shape(x, t.Elem()) {
				return false
			}
		}
		return true
	case reflect.String:
		_, ok := v.(string)
		return ok
	case reflect.Bool:
		_, ok := v.(bool)
		return ok
	case reflect.Int64, reflect.Int:
		x, ok := v.(json.Number)
		return ok && integerPattern.MatchString(string(x))
	}
	return false
}

// encoding/json replaces isolated escaped UTF-16 surrogates. Reject them before
// decoding so Go, JavaScript and Python observe the same Unicode scalar values.
func pairedSurrogates(data []byte) bool {
	quoted := false
	for i := 0; i < len(data); i++ {
		if !quoted {
			if data[i] == '"' {
				quoted = true
			}
			continue
		}
		if data[i] == '"' {
			quoted = false
			continue
		}
		if data[i] != 92 {
			continue
		}
		i++
		if i >= len(data) {
			return false
		}
		if data[i] != 'u' {
			continue
		}
		if i+5 > len(data) {
			return false
		}
		value, err := strconv.ParseUint(string(data[i+1:i+5]), 16, 16)
		if err != nil {
			return false
		}
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value >= 0xd800 && value <= 0xdbff {
			if i+11 > len(data) || data[i+5] != 92 || data[i+6] != 'u' {
				return false
			}
			low, err := strconv.ParseUint(string(data[i+7:i+11]), 16, 16)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 10
		} else {
			i += 4
		}
	}
	return true
}
