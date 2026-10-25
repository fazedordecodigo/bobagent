#!/usr/bin/env bash
# Builds the guest image for BobAgent microVMs on the Linux host:
#   ~/.bobagent/firecracker/rootfs.ext4  (Debian + bun + socat + provider CLIs)
#   ~/.bobagent/firecracker/vmlinux      (Firecracker CI guest kernel)
#   ~/.bobagent/firecracker/firecracker  (release binary)
# Requires: docker, curl, mkfs.ext4, sudo (for loop mounts). No credentials go into the
# image; sign in to provider CLIs inside a microVM or pass API keys via the BobAgent vault.
#
# usage: build-rootfs.sh [--size-mib 4096] [--providers "claude codex"]
set -euo pipefail
FC_VERSION="${FC_VERSION:-v1.12.1}"
KERNEL_URL="${KERNEL_URL:-https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.12/$(uname -m)/vmlinux-6.1.128}"
SIZE_MIB=4096
PROVIDERS="claude codex"
while [ $# -gt 0 ]; do
  case "$1" in
    --size-mib) SIZE_MIB="$2"; shift 2 ;;
    --providers) PROVIDERS="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
ROOT="${BOBAGENT_HOST_ROOT:-$HOME/.bobagent}"
OUT="$ROOT/firecracker"
HERE="$(cd "$(dirname "$0")" && pwd)"
HELPER="$ROOT/bin/bobagent-host.ts"
[ -f "$HELPER" ] || { echo "install the helper first (BobAgent → Settings → Hosts → Install)" >&2; exit 1; }
[ -e /dev/kvm ] || echo "warning: /dev/kvm missing; microVMs will not boot on this host" >&2
mkdir -p "$OUT"
ARCH="$(uname -m)"

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
cp "$HELPER" "$work/bobagent-host.ts"
cp "$HERE/bobagent-init" "$work/bobagent-init" 2>/dev/null || cp "$ROOT/bin/bobagent-init" "$work/bobagent-init"
cat > "$work/Dockerfile" <<DOCKER
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git socat iproute2 unzip nodejs npm \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
COPY bobagent-host.ts /opt/bobagent/bobagent-host.ts
COPY bobagent-init /sbin/bobagent-init
RUN chmod 0755 /sbin/bobagent-init \
 && printf '#!/bin/sh\nexec bun /opt/bobagent/bobagent-host.ts bridge\n' > /usr/local/bin/bobagent-bridge \
 && chmod 0755 /usr/local/bin/bobagent-bridge
RUN for p in ${PROVIDERS}; do case "\$p" in \
      claude) npm install -g @anthropic-ai/claude-code ;; \
      codex) npm install -g @openai/codex ;; \
      gemini) npm install -g @google/gemini-cli ;; \
      opencode) npm install -g opencode-ai ;; \
    esac; done
DOCKER
docker build -t bobagent-guest "$work"
cid="$(docker create bobagent-guest)"
docker export "$cid" -o "$work/rootfs.tar"
docker rm "$cid" >/dev/null
truncate -s "${SIZE_MIB}M" "$work/rootfs.ext4"
mkfs.ext4 -q -F "$work/rootfs.ext4"
mkdir -p "$work/mnt"
sudo mount -o loop "$work/rootfs.ext4" "$work/mnt"
sudo tar -xf "$work/rootfs.tar" -C "$work/mnt"
sudo umount "$work/mnt"
mv "$work/rootfs.ext4" "$OUT/rootfs.ext4"
sha256sum "$OUT/vmlinux" "$OUT/rootfs.ext4" "$OUT/firecracker" > "$OUT/SHA256SUMS"
echo "ready: $OUT (run Check in BobAgent → Settings → Hosts)"
