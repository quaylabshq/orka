package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/whysosaket/orka-api/internal/livesessions"
)

func run() error {
	if os.Getenv("ORKA_EXPERIMENTAL_LIVE_SESSIONS") != "1" {
		return errors.New("experimental live sessions are disabled")
	}
	auth, e := livesessions.CoreAuthority(os.Getenv("ORKA_LIVE_SESSION_CORE_URL"), os.Getenv("ORKA_LIVE_SESSION_RELAY_SECRET"))
	if e != nil {
		return e
	}
	dir := os.Getenv("ORKA_LIVE_SESSION_JOURNAL_DIR")
	if dir == "" {
		return errors.New("set ORKA_LIVE_SESSION_JOURNAL_DIR")
	}
	store, e := livesessions.Open(dir)
	if e != nil {
		return e
	}
	defer store.Close()
	addr := os.Getenv("ORKA_LIVE_SESSION_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:8091"
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := &http.Server{Addr: addr, Handler: livesessions.New(store, auth), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	finished := make(chan error, 1)
	go func() { finished <- server.ListenAndServe() }()
	select {
	case e := <-finished:
		return e
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 17*time.Second)
		defer cancel()
		return server.Shutdown(shutdown)
	}
}
func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
