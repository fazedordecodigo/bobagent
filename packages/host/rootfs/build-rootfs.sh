#!/usr/bin/env bash
# Builds the guest image for Boto microVMs on the Linux host:
#   ~/.boto/firecracker/rootfs.ext4  (Debian + bun + socat + provider CLIs)
#   ~/.boto/firecracker/vmlinux      (Firecracker CI guest kernel)
#   ~/.boto/firecracker/firecracker  (release binary)
# Requires: docker, curl, mkfs.ext4, sudo (for loop mounts). No credentials go into the
# image; sign in to provider CLIs inside a microVM or pass API keys via the Boto vault.
#
# usage: build-rootfs.sh [--size-mib 4096] [--providers "claude codex gemini opencode cursor"] [--base image]
set -euo pipefail
FC_VERSION="${FC_VERSION:-v1.12.1}"
KERNEL_URL="${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/$(uname -m)/vmlinux-6.1.128}"
SIZE_MIB=4096
PROVIDERS="claude codex"
BASE="${BOTO_ROOTFS_BASE:-}"
BASE_EXPLICIT=0
[ -n "$BASE" ] && BASE_EXPLICIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --size-mib) SIZE_MIB="$2"; shift 2 ;;
    --providers) PROVIDERS="$2"; shift 2 ;;
    --base)
      [ $# -ge 2 ] && [ -n "$2" ] || { echo "--base requires an image reference" >&2; exit 2; }
      BASE="$2"
      BASE_EXPLICIT=1
      shift 2
      ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
ROOT="${BOTO_HOST_ROOT:-$HOME/.boto}"
if [ -z "${BOTO_HOST_ROOT:-}" ] && [ ! -e "$ROOT" ] && [ -d "$HOME/.upbot" ]; then
  mv "$HOME/.upbot" "$ROOT"
fi
OUT="$ROOT/firecracker"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$ROOT/bin/boto-host.ts"
if [ ! -f "$HELPER" ]; then
  HELPER="$HERE/../src/main.ts"
  [ -f "$HELPER" ] || { echo "boto-host source not found; run this script from a Boto checkout or install the helper first" >&2; exit 1; }
fi
[ -e /dev/kvm ] || echo "warning: /dev/kvm missing; microVMs will not boot on this host" >&2
mkdir -p "$OUT"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported architecture for Node.js guest: $ARCH" >&2; exit 1 ;;
esac

if [ "$BASE_EXPLICIT" -eq 0 ]; then
  candidates=(
    "debian:bookworm-slim"
    "mirror.gcr.io/library/debian:bookworm-slim"
    "public.ecr.aws/docker/library/debian:bookworm-slim"
  )
  for candidate in "${candidates[@]}"; do
    if docker image inspect "$candidate" >/dev/null 2>&1 || docker pull "$candidate"; then
      BASE="$candidate"
      break
    fi
  done
  if [ -z "$BASE" ]; then
    printf 'failed to find or pull a rootfs base image; tried:\n' >&2
    printf '  %s\n' "${candidates[@]}" >&2
    exit 1
  fi
elif ! docker image inspect "$BASE" >/dev/null 2>&1 && ! docker pull "$BASE"; then
  echo "failed to pull explicit rootfs base image $BASE" >&2
  exit 1
fi
case "$BASE" in
  *[[:space:]]*) echo "invalid base image reference: whitespace is not allowed" >&2; exit 2 ;;
esac
echo "using base image $BASE" >&2

if [ ! -x "$OUT/firecracker" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz" -o "$tmp/fc.tgz"
  curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-${ARCH}.tgz.sha256.txt" -o "$tmp/fc.sha256"
  (cd "$tmp" && sed "s#firecracker-${FC_VERSION}-${ARCH}.tgz#fc.tgz#" fc.sha256 | sha256sum -c -)
  tar -xzf "$tmp/fc.tgz" -C "$tmp"
  install -m 0755 "$tmp/release-${FC_VERSION}-${ARCH}/firecracker-${FC_VERSION}-${ARCH}" "$OUT/firecracker"
  rm -rf "$tmp"
fi
[ -f "$OUT/vmlinux" ] || curl -fsSL "$KERNEL_URL" -o "$OUT/vmlinux"

work="$(mktemp -d)"
trap 'sudo umount "$work/mnt" 2>/dev/null || true; rm -rf "$work"' EXIT
cp "$HELPER" "$work/boto-host.ts"
cp "$HERE/boto-init" "$work/boto-init" 2>/dev/null || cp "$ROOT/bin/boto-init" "$work/boto-init"
cat > "$work/Dockerfile" <<DOCKER
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git socat iproute2 unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
 mkdir -p /tmp/node-dist; \
 curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o /tmp/node-dist/SHASUMS256.txt; \
 tarball="\$(awk -v arch="${NODE_ARCH}" '\$2 ~ "^node-v[0-9.]+-linux-" arch "\\\\.tar\\\\.xz$" {print \$2; exit}' /tmp/node-dist/SHASUMS256.txt)"; \
 test -n "\$tarball"; \
 grep " \$tarball\\$" /tmp/node-dist/SHASUMS256.txt > /tmp/node-dist/node.sha256; \
 curl -fsSL "https://nodejs.org/dist/latest-v22.x/\$tarball" -o "/tmp/node-dist/\$tarball"; \
 (cd /tmp/node-dist && sha256sum -c node.sha256); \
 tar -xJf "/tmp/node-dist/\$tarball" -C /usr/local --strip-components=1; \
 rm -rf /tmp/node-dist
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
COPY boto-host.ts /opt/boto/boto-host.ts
COPY boto-init /sbin/boto-init
RUN chmod 0755 /sbin/boto-init \
 && printf '#!/bin/sh\nexec bun /opt/boto/boto-host.ts bridge\n' > /usr/local/bin/boto-bridge \
 && chmod 0755 /usr/local/bin/boto-bridge
RUN for p in ${PROVIDERS}; do case "\$p" in \
      claude) npm install -g @anthropic-ai/claude-code ;; \
      codex) npm install -g @openai/codex ;; \
      gemini) npm install -g @google/gemini-cli ;; \
      opencode) npm install -g opencode-ai ;; \
      cursor) HOME=/opt/cursor-agent-home bash -c 'curl -fsS https://cursor.com/install | bash' && ln -sf /opt/cursor-agent-home/.local/bin/agent /usr/local/bin/agent ;; \
    esac; done
DOCKER
docker build -t boto-guest "$work"
cid="$(docker create boto-guest)"
docker export "$cid" -o "$work/rootfs.tar"
docker rm "$cid" >/dev/null
truncate -s "${SIZE_MIB}M" "$work/rootfs.ext4"
mkfs.ext4 -q -F "$work/rootfs.ext4"
mkdir -p "$work/mnt"
sudo mount -o loop "$work/rootfs.ext4" "$work/mnt"
sudo tar -xf "$work/rootfs.tar" -C "$work/mnt"
sudo umount "$work/mnt"
mv "$work/rootfs.ext4" "$OUT/rootfs.ext4"
sha256sum "$work/boto-host.ts" | awk '{print $1}' > "$OUT/guest-helper.sha256"
sha256sum "$OUT/vmlinux" "$OUT/rootfs.ext4" "$OUT/firecracker" > "$OUT/SHA256SUMS"
echo "ready: $OUT (run Check in Boto → Settings → Hosts)"
