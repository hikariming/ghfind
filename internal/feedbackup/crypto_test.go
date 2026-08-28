package feedbackup

import (
	"bytes"
	"crypto/rand"
	"testing"
)

func TestEncryptDecryptChunksRoundTrip(t *testing.T) {
	t.Parallel()
	key := bytes.Repeat([]byte{0x42}, 32)
	plaintext := make([]byte, 3*64*1024+17)
	if _, err := rand.Read(plaintext); err != nil {
		t.Fatal(err)
	}
	var encrypted bytes.Buffer
	if err := encryptChunks(&encrypted, bytes.NewReader(plaintext), key, 64*1024); err != nil {
		t.Fatal(err)
	}
	var decrypted bytes.Buffer
	if err := decryptChunks(&decrypted, bytes.NewReader(encrypted.Bytes()), key); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plaintext, decrypted.Bytes()) {
		t.Fatal("decrypted plaintext differs")
	}
}

func TestDecryptChunksRejectsTamperAndTruncation(t *testing.T) {
	t.Parallel()
	key := bytes.Repeat([]byte{0x51}, 32)
	var encrypted bytes.Buffer
	if err := encryptChunks(&encrypted, bytes.NewReader(bytes.Repeat([]byte("x"), 100_000)), key, 64*1024); err != nil {
		t.Fatal(err)
	}

	tampered := append([]byte(nil), encrypted.Bytes()...)
	tampered[len(tampered)/2] ^= 0xff
	if err := decryptChunks(&bytes.Buffer{}, bytes.NewReader(tampered), key); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}

	truncated := encrypted.Bytes()[:encrypted.Len()-1]
	if err := decryptChunks(&bytes.Buffer{}, bytes.NewReader(truncated), key); err == nil {
		t.Fatal("truncated ciphertext was accepted")
	}
}
