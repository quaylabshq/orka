FROM --platform=$BUILDPLATFORM golang:1.27.4-bookworm AS build-base
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd cmd
COPY internal internal
COPY packages/server-core/migrations packages/server-core/migrations

FROM build-base AS build
ARG VERSION=development
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/whysosaket/orka-api/internal/server.Version=${VERSION} -X github.com/whysosaket/orka-api/internal/server.Edition=oss" -o /out/oss ./cmd/orka-server \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/whysosaket/orka-api/internal/server.Version=${VERSION} -X github.com/whysosaket/orka-api/internal/server.Edition=managed" -o /out/managed ./cmd/orka-server

FROM build-base AS build-live-relay
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/live-relay ./cmd/orka-live-relay

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 1000 orka && useradd --uid 1000 --gid orka --no-create-home orka \
 && mkdir -p /app /data/blobs && chown orka:orka /data/blobs
WORKDIR /app
COPY LICENSE THIRD_PARTY_NOTICES.md GO_THIRD_PARTY_NOTICES.md ./
COPY licenses licenses
USER orka
EXPOSE 8080
CMD ["orka-server", "serve"]

FROM runtime AS managed
COPY --from=build /out/managed /usr/local/bin/orka-server

FROM runtime AS live-relay
USER root
RUN install -d -m 700 -o orka -g orka /var/lib/orka-live
USER orka
COPY --from=build-live-relay /out/live-relay /usr/local/bin/orka-live-relay
CMD ["orka-live-relay"]

FROM runtime AS oss
COPY --from=build /out/oss /usr/local/bin/orka-server
