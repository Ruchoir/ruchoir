# syntax=docker/dockerfile:1.7
# Multi-stage build for the single Ruchoir production service.
#
# The Rust API also serves the static web bundle, so this image bundles both:
#   1. `web`  - builds the Next.js static export (Node, build-time only).
#   2. `api`  - builds the release Rust binary.
#   3. runtime - a slim image with the binary and the exported web assets.
#
# BuildKit cache mounts (the `--mount=type=cache` lines) persist the cargo registry, the
# Rust `target` dir and the pnpm store across builds, so a rebuild only recompiles the code
# that actually changed instead of every dependency. Build context is the repository root.

# ---------------------------------------------------------------------------
# Stage 1: build the static web bundle.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /build
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY apps/web ./apps/web
RUN --mount=type=cache,target=/build/apps/web/.next/cache \
    pnpm --filter @ruchoir/web build

# ---------------------------------------------------------------------------
# Stage 2: build the Rust API (release).
# ---------------------------------------------------------------------------
FROM rust:1.96-slim-bookworm AS api
# OpenSSL headers, needed by `webauthn-rs`, which uses OpenSSL to validate passkey attestation
# certificates. Transport TLS remains rustls with the `ring` provider (see AGENTS.md); this is a
# crypto library pulled in by a dependency, not a TLS backend choice. A development machine usually
# has these already, which is why building this image only failed on a clean host.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY rust-toolchain.toml Cargo.toml ./
COPY Cargo.lock* ./
COPY apps/api ./apps/api
COPY migrations ./migrations
# Cache the cargo registry/git and the target dir. The binary is copied out of the cached
# target within the same layer (cache mounts are not part of the image filesystem).
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/usr/local/cargo/git \
    --mount=type=cache,target=/build/target \
    cargo build --release -p ruchoir-api \
    && cp target/release/ruchoir-api /usr/local/bin/ruchoir-api

# ---------------------------------------------------------------------------
# Stage 3: minimal runtime.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
# `libssl3` is the runtime half of the build dependency above: `openssl-sys` links dynamically, so
# the binary needs the shared library even though nothing here terminates TLS with it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --user-group ruchoir
WORKDIR /srv/ruchoir
COPY --from=api /usr/local/bin/ruchoir-api /usr/local/bin/ruchoir-api
COPY --from=web /build/apps/web/out /srv/ruchoir/web
ENV RUCHOIR_API_HOST=0.0.0.0 \
    RUCHOIR_API_PORT=8080 \
    RUCHOIR_WEB_DIST=/srv/ruchoir/web \
    RUST_LOG=info
USER ruchoir
EXPOSE 8080
CMD ["ruchoir-api"]
