# Experimental live session relay

The desktop sends redacted conversation messages to a separate relay while the author is sharing a live session. The core API owns membership, session ownership, authorship, provenance, publication permissions and the 24-hour episode lifetime. The relay receives presentation JSONL and stores it in a private journal. It authenticates each read or write against the core service. An unavailable core pauses delivery. Browsing a session and “Share with team” retain their existing behavior.

## Run an isolated source stack

Configure a fresh local checkout and disposable project with the normal local setup. Set a private random `ORKA_LIVE_SESSION_RELAY_SECRET` of at least 32 characters for the Compose invocation. Keep the same value on the core API and the relay. Add the optional local overlay, then start the stack with Docker Compose 2.24.4 or newer.

```sh
docker compose -f compose.yml -f deploy/local/compose.yml -f deploy/live-sessions/compose.yml up --build -d caddy
```

This overlay explicitly enables the experiment and routes both API and relay requests through the existing local desktop service origin. Caddy is the only published port. The core authorization endpoint stays on the internal service network. Use the same file list when stopping the stack. Its named journal volume persists across restarts.

For a standalone developer process, build with `go build -o orka-live-relay ./cmd/orka-live-relay`. Provide the following environment values.

| Variable | Value |
| --- | --- |
| `ORKA_EXPERIMENTAL_LIVE_SESSIONS` | `1` on the core API and relay |
| `ORKA_LIVE_SESSION_RELAY_SECRET` | Same private secret on the two processes |
| `ORKA_LIVE_SESSION_CORE_URL` | Fixed, operator-supplied core origin, for example `http://127.0.0.1:8080` in a local fixture |
| `ORKA_LIVE_SESSION_LISTEN` | Optional relay bind address, defaults to `127.0.0.1:8091` |
| `ORKA_LIVE_SESSION_JOURNAL_DIR` | Dedicated persistent private directory writable by one relay process |

A same-origin gateway forwards `/v1/live/rooms/*` to the relay. The desktop uses the account bearer token for that configured service. Only the relay calls `POST /internal/live-sessions/authorize` over the trusted internal network. Use TLS for inter-host links. Redirects from the authorization origin fail closed. The managed and self-hosted API use the same authorization contract. The optional Docker build target is `live-relay`.

## Data protocol

The base path is `/v1/live/rooms/{projectId}/{resourceId}/{episodeId}`. The owner starts or stops the episode through the core API. The writer uses its registered device identity and sends the actual current context-source IDs on every write. Each record is one UTF-8 JSON object containing a user or assistant `role` and a string `text`, followed by a newline. The client performs native session redaction and presentation filtering before transfer. Hashes are lowercase SHA-256 over the exact accumulated JSONL bytes.

| Operation | Contract |
| --- | --- |
| `PUT /checkpoint` | Replace the transcript against a matching `baseCursor` and `baseHash`. The initial cursor is zero and its hash is SHA-256 of empty bytes. |
| `POST /append` | Append complete records after a checkpoint, using the same base checks. |
| `GET /content` | Return a full checkpoint. With `cursor` and `hash`, return the checked suffix if the retained base matches. A rewrite, pruned cursor or hash mismatch returns a full replacement with `reset:true`. |
| `GET /wait?cursor=N` | A held request returns only the latest cursor. The relay coalesces changes for 100 ms, returns after 10 seconds of idle, and checks current read access before every reply. |

Both mutation bodies contain `requestId`, `deviceId`, `contextSources`, `baseCursor`, `baseHash`, `hash` and `records`. Empty provenance is an explicit array. A successful mutation returns `{cursor,hash}`. A stale base or changed reuse of a request ID returns HTTP 409 with the current position. Recent exact retries replay their original receipt. Older retries still have to match the base cursor. Content returns `{cursor,hash,reset,records}`. A terminal authorization failure returns no cursor or transcript. Once a recipient has received a record, revocation applies to later delivery.

## Runtime bounds and recovery

One process owns the journal directory through an exclusive file lock. It fsyncs each accepted frame before acknowledging it. A checksum and SHA-256 protect recovery. Restart truncates an incomplete final append to the last intact acknowledged frame and rejects corrupted complete frames. Checkpoints atomically replace prior contents. The relay retains up to 128 recent positions and receipts and compacts the journal as that window fills. It removes journals after verified terminal authorization or expiry. Core expiry is 24 hours and relay cleanup uses a 25-hour grace period.

The default ceilings are 16 rooms, 16 MiB per complete presentation, 64 MiB total current presentations, 256 KiB per append or row, two concurrent incoming mutations, 16 MiB of in-flight content response payloads, 48 in-flight requests, 32 held requests and eight held requests per room. HTTP 429 signals admission pressure. A client can reconnect with its last verified position. Body reads, held requests, outgoing writes and core authorization have timeouts. Run `go test -race ./internal/livesessions` for the relay contract and durability checks.

At room or byte pressure, a new checkpoint can recheck one idle retained episode per second. Only a terminal result from the core deletes it. Other projects' inaccessible episodes keep their journals until an authorized request observes their end or local retention expires.

Five continuously waiting viewers generate about one core read authorization per second in total while idle. Each 10-second hold checks admission and completion. An active notification adds one content authorization per viewer fetching a suffix. Writes require one authorization per operation. The configured core timeout is three seconds.

## Measured local workload

One publisher sent 24 completed 1 KiB records to five signed-in viewers after each viewer had loaded a 10 MiB checkpoint. The disposable stack ran Caddy, the relay, the core API, GoTrue and PostgreSQL on one machine. Across 120 deliveries, time from the append becoming available to verification by a viewer was 155 ms at the median and 220 ms at p95.

The five initial checkpoints used 52,890,165 response-body bytes. Subsequent notifications and suffix reads used 129,100 response-body bytes for 122,880 bytes of new content. The publisher sent 32,055 request-body bytes and received 2,104 acknowledgement bytes. These counts exclude HTTP headers and TLS. Retransmitting a full 10 MiB checkpoint after each of those appends would send at least 1,200 MiB to the same viewers.

The relay peaked at 93.4 MiB in this run. During the 1.52-second burst, its container used 0.045 CPU-seconds, the core used 0.10, GoTrue used 0.84 and PostgreSQL used 2.23. These container counters include background work. Before enabling a pilot on a shared host, measure core and database headroom with the intended traffic and watch existing sync latency. The local run establishes neither Internet latency nor production capacity.
