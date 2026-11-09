# Application image (Milestone 16): the API, the migration job and the
# recovery CLI, with the same-origin SPA. Build from the repository root:
#
#   docker build --build-arg VERSION=<version> \
#     --build-arg REVISION="$(git rev-parse HEAD)" -t ecom:<version> .
#
# Base images are pinned by digest, each at least two weeks old when chosen
# (docs/updated/DECISIONS.md, "Packaging (Milestone 16)").

# Frontend: the same build `dev.sh serve-https` uses, with /api/v1 on the page origin.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --strict-peer-deps --no-audit --no-fund
COPY fixtures/public/ /src/fixtures/public/
COPY frontend/ ./
RUN npm run build:same-origin

# Go: static binaries. The fixtures tool is not shipped.
FROM golang:1.27.3-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS go
WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=readonly
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY backend/ backend/
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -trimpath -buildvcs=false -ldflags='-s -w' -o /out/ \
      ./backend/cmd/api ./backend/cmd/migrate ./backend/cmd/reconcile

# Runtime: no shell or package manager; user 65532 (nonroot).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="ecom" \
      org.opencontainers.image.description="Commerce Reliability Lab API, migration job and recovery CLI with the built SPA" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99"
# Root-owned and read-only to the runtime user.
COPY --from=go /out/api /out/migrate /out/reconcile /usr/local/bin/
COPY --from=frontend /src/frontend/dist/ /app/dist/
ENV STATIC_DIR=/app/dist
WORKDIR /app
USER 65532:65532
# Run another binary by naming it: `docker run <image> migrate up`.
CMD ["api"]
