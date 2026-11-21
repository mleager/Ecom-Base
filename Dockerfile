# Application image (Milestone 16): the API, the migration job, the database
# bootstrap (M17) and the recovery CLI, with the same-origin SPA. Build from
# the repository root:
#
#   docker build --build-arg VERSION=<version> \
#     --build-arg REVISION="$(git rev-parse HEAD)" -t ecom:<version> .
#
# Base images are pinned by digest, each at least two weeks old when chosen
# (docs/DECISIONS.md, "Delivery").

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
      ./backend/cmd/api ./backend/cmd/migrate ./backend/cmd/reconcile ./backend/cmd/maintain ./backend/cmd/db-bootstrap

# Amazon RDS CA bundle (every region), pinned by checksum: database URLs on AWS
# use sslrootcert=/etc/ssl/rds/global-bundle.pem, so tasks download nothing at
# start. If AWS republishes the bundle, the build fails here until the
# checksum is updated deliberately (docs/terraform/DESIGN.md). Modes are set
# here, where there is a shell: ADD --chmod would also make the new directory
# 0444, which user 65532 cannot enter.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /out/rds/global-bundle.pem
RUN chmod 0755 /out/rds && chmod 0444 /out/rds/global-bundle.pem

# Runtime: no shell or package manager; user 65532 (nonroot).
FROM gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99
ARG VERSION=dev
ARG REVISION=unknown
# "base" is the baseline application. Scenario projects publish fault-variant
# builds (ecom-<variant>) from documented branches of this repository; their
# description must say what is broken on purpose.
ARG VARIANT=base
ARG DESCRIPTION="Commerce Reliability Lab baseline: API, migration job, database bootstrap and recovery CLI with the built SPA"
LABEL org.opencontainers.image.title="ecom-${VARIANT}" \
      org.opencontainers.image.description="${DESCRIPTION}" \
      org.opencontainers.image.source="https://github.com/mleager/Ecom-Base" \
      io.github.mleager.ecom.variant="${VARIANT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.base.name="gcr.io/distroless/static-debian13:nonroot" \
      org.opencontainers.image.base.digest="sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99"
# Root-owned and read-only to the runtime user.
COPY --from=go /out/api /out/migrate /out/reconcile /out/maintain /out/db-bootstrap /usr/local/bin/
COPY --from=go /out/rds/ /etc/ssl/rds/
COPY --from=frontend /src/frontend/dist/ /app/dist/
ENV STATIC_DIR=/app/dist
WORKDIR /app
USER 65532:65532
# Run another binary by naming it: `docker run <image> migrate up`.
CMD ["api"]
