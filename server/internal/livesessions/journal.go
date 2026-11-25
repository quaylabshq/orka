package livesessions

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
)

// Each durable frame has a length-delimited JSON header, raw JSONL and CRC.
// An acknowledged append is fsynced. A checkpoint replaces the journal by rename.
type journalFrame struct {
	Receipt receipt   `json:"receipt"`
	Reset   bool      `json:"reset"`
	Bytes   int       `json:"bytes"`
	Prior   []receipt `json:"prior,omitempty"`
}

const maxHeader = 64 << 10

func saveFrame(dir, name string, frame journalFrame, data []byte) error {
	path := filepath.Join(dir, name)
	target := path
	var f *os.File
	var e error
	if frame.Reset {
		target = path + ".pending"
		f, e = os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		defer os.Remove(target)
	} else {
		f, e = os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0600)
	}
	if e != nil {
		return e
	}
	defer f.Close()
	header, e := json.Marshal(frame)
	if e != nil {
		return e
	}
	if len(header) > maxHeader {
		return errors.New("journal header too large")
	}
	out := bufio.NewWriterSize(f, 32<<10)
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(len(header)))
	crc := crc32.NewIEEE()
	checked := io.MultiWriter(out, crc)
	if _, e = out.Write(n[:]); e != nil {
		return e
	}
	if _, e = checked.Write(header); e != nil {
		return e
	}
	if _, e = checked.Write(data); e != nil {
		return e
	}
	binary.BigEndian.PutUint32(n[:], crc.Sum32())
	if _, e = out.Write(n[:]); e != nil {
		return e
	}
	if e = out.Flush(); e != nil {
		return e
	}
	if e = f.Sync(); e != nil {
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if !frame.Reset {
		return nil
	}
	if e = os.Rename(target, path); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func restoreRoom(path string, r *room) error {
	f, e := os.OpenFile(path, os.O_RDWR, 0600)
	if e != nil {
		return e
	}
	defer f.Close()
	in := bufio.NewReaderSize(f, 32<<10)
	var offset int64
	torn := func() error {
		if r.head.Cursor == 0 {
			return errors.New("truncated initial live checkpoint")
		}
		if e := f.Truncate(offset); e != nil {
			return e
		}
		return f.Sync()
	}
	for {
		var prefix [4]byte
		_, e := io.ReadFull(in, prefix[:])
		if e == io.EOF {
			if offset == 0 {
				return errors.New("empty live journal")
			}
			return nil
		}
		if e == io.ErrUnexpectedEOF {
			return torn()
		}
		if e != nil {
			return e
		}
		size := int(binary.BigEndian.Uint32(prefix[:]))
		if size < 2 || size > maxHeader {
			return errors.New("invalid live frame header")
		}
		header := make([]byte, size)
		if _, e = io.ReadFull(in, header); e != nil {
			if e == io.EOF || e == io.ErrUnexpectedEOF {
				return torn()
			}
			return e
		}
		var frame journalFrame
		if e = json.Unmarshal(header, &frame); e != nil {
			return e
		}
		if frame.Bytes < 0 || frame.Bytes > maxSession || len(frame.Prior) >= historyLimit || frame.Receipt.Cursor <= 0 || !uuid.MatchString(frame.Receipt.ID) || !digestPattern.MatchString(frame.Receipt.Proof) || (r.head.Cursor == 0) != frame.Reset {
			return errors.New("invalid journal frame")
		}
		if !frame.Reset && (frame.Receipt.Cursor != r.head.Cursor+1 || frame.Bytes > maxAppend || len(r.body)+frame.Bytes > maxSession || len(r.marks) >= historyLimit) {
			return errors.New("invalid journal append")
		}
		data := make([]byte, frame.Bytes)
		if _, e = io.ReadFull(in, data); e != nil {
			if e == io.EOF || e == io.ErrUnexpectedEOF {
				return torn()
			}
			return e
		}
		if _, e = io.ReadFull(in, prefix[:]); e != nil {
			if e == io.EOF || e == io.ErrUnexpectedEOF {
				return torn()
			}
			return e
		}
		crc := crc32.NewIEEE()
		crc.Write(header)
		crc.Write(data)
		if binary.BigEndian.Uint32(prefix[:]) != crc.Sum32() {
			return errors.New("live journal checksum mismatch")
		}
		if frame.Reset {
			r.sum = sha256.New().(hash.Cloner)
			r.body = data
			r.receipts = frame.Prior
		} else {
			r.body = append(r.body, data...)
		}
		r.sum.Write(data)
		if hex.EncodeToString(r.sum.Sum(nil)) != frame.Receipt.Hash {
			return errors.New("live journal digest mismatch")
		}
		r.receipts = appendRecent(r.receipts, frame.Receipt)
		r.head = frame.Receipt.Position
		r.marks = append(r.marks, mark{r.head, len(r.body)})
		offset += int64(8 + size + frame.Bytes)
	}
}
