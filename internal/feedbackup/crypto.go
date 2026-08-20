package feedbackup

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
)

const backupMagic = "GHFINDBACKUPv1\n"

// encryptChunks uses independently authenticated AES-256-GCM chunks so a
// multi-gigabyte dump never needs to be resident in memory. The authenticated
// empty final record makes truncation detectable even before manifest hashes
// are checked.
func encryptChunks(dst io.Writer, src io.Reader, key []byte, chunkSize int) error {
	if len(key) != 32 {
		return errors.New("encryption key must be 32 bytes")
	}
	if chunkSize < 64*1024 || chunkSize > 64<<20 {
		return errors.New("chunk size outside safe range")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}
	// Eight random bytes plus a 32-bit per-file sequence produce a 96-bit GCM
	// nonce. This avoids a birthday-bound collision on a short file prefix while
	// still supporting far more chunks than the database volume can contain.
	noncePrefix := make([]byte, 8)
	if _, err := io.ReadFull(rand.Reader, noncePrefix); err != nil {
		return fmt.Errorf("generate nonce prefix: %w", err)
	}
	if _, err := io.WriteString(dst, backupMagic); err != nil {
		return err
	}
	if err := binary.Write(dst, binary.BigEndian, uint32(chunkSize)); err != nil {
		return err
	}
	if _, err := dst.Write(noncePrefix); err != nil {
		return err
	}

	buffer := make([]byte, chunkSize)
	var sequence uint64
	for {
		n, readErr := io.ReadFull(src, buffer)
		if n > 0 {
			if err := sealRecord(dst, gcm, noncePrefix, sequence, buffer[:n]); err != nil {
				return err
			}
			sequence++
		}
		switch readErr {
		case nil:
			continue
		case io.EOF, io.ErrUnexpectedEOF:
			return sealRecord(dst, gcm, noncePrefix, sequence, nil)
		default:
			return fmt.Errorf("read plaintext: %w", readErr)
		}
	}
}

func decryptChunks(dst io.Writer, src io.Reader, key []byte) error {
	if len(key) != 32 {
		return errors.New("encryption key must be 32 bytes")
	}
	magic := make([]byte, len(backupMagic))
	if _, err := io.ReadFull(src, magic); err != nil {
		return fmt.Errorf("read backup header: %w", err)
	}
	if string(magic) != backupMagic {
		return errors.New("unsupported backup format")
	}
	var chunkSize uint32
	if err := binary.Read(src, binary.BigEndian, &chunkSize); err != nil {
		return fmt.Errorf("read chunk size: %w", err)
	}
	if chunkSize < 64*1024 || chunkSize > 64<<20 {
		return errors.New("backup chunk size outside safe range")
	}
	noncePrefix := make([]byte, 8)
	if _, err := io.ReadFull(src, noncePrefix); err != nil {
		return fmt.Errorf("read nonce prefix: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return err
	}

	var sequence uint64
	for {
		var plaintextLength uint32
		if err := binary.Read(src, binary.BigEndian, &plaintextLength); err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("encrypted backup is truncated before authenticated final record")
			}
			return fmt.Errorf("read record length: %w", err)
		}
		if plaintextLength > chunkSize {
			return errors.New("encrypted record exceeds declared chunk size")
		}
		if sequence > math.MaxUint32 {
			return errors.New("encrypted backup contains too many records")
		}
		ciphertext := make([]byte, int(plaintextLength)+gcm.Overhead())
		if _, err := io.ReadFull(src, ciphertext); err != nil {
			return fmt.Errorf("read encrypted record: %w", err)
		}
		plaintext, err := gcm.Open(nil, recordNonce(noncePrefix, sequence), ciphertext, recordAAD(sequence, plaintextLength))
		if err != nil {
			return fmt.Errorf("authenticate encrypted record %d: %w", sequence, err)
		}
		if plaintextLength == 0 {
			var trailing [1]byte
			n, err := src.Read(trailing[:])
			if n != 0 || (err != nil && !errors.Is(err, io.EOF)) {
				return errors.New("encrypted backup has trailing data")
			}
			return nil
		}
		if _, err := dst.Write(plaintext); err != nil {
			return fmt.Errorf("write decrypted record: %w", err)
		}
		sequence++
	}
}

func sealRecord(dst io.Writer, gcm cipher.AEAD, noncePrefix []byte, sequence uint64, plaintext []byte) error {
	if sequence > math.MaxUint32 {
		return errors.New("backup contains too many records")
	}
	if err := binary.Write(dst, binary.BigEndian, uint32(len(plaintext))); err != nil {
		return err
	}
	ciphertext := gcm.Seal(nil, recordNonce(noncePrefix, sequence), plaintext, recordAAD(sequence, uint32(len(plaintext))))
	_, err := dst.Write(ciphertext)
	return err
}

func recordNonce(prefix []byte, sequence uint64) []byte {
	nonce := make([]byte, 12)
	copy(nonce[:8], prefix)
	binary.BigEndian.PutUint32(nonce[8:], uint32(sequence))
	return nonce
}

func recordAAD(sequence uint64, plaintextLength uint32) []byte {
	aad := make([]byte, len(backupMagic)+12)
	copy(aad, backupMagic)
	binary.BigEndian.PutUint64(aad[len(backupMagic):], sequence)
	binary.BigEndian.PutUint32(aad[len(backupMagic)+8:], plaintextLength)
	return aad
}
