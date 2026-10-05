#!/bin/sh
set -eu

# Usage: curl -fsSL https://raw.githubusercontent.com/HVHBIGNAME/tmcp/main/install.sh | sh
# Optional: TMCP_HOME, TMCP_VERSION, TMCP_ROOT, TMCP_NO_START=1, TMCP_AUTOSTART=1.
REPO="HVHBIGNAME/tmcp"
HOME_DIR="${TMCP_HOME:-$HOME/.local/share/tmcp}"
VERSION="${TMCP_VERSION:-latest}"
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) printf 'Use install.ps1 on Windows.\n' >&2; exit 1 ;; esac
case "$ARCH" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) printf 'Unsupported architecture: %s\n' "$ARCH" >&2; exit 1 ;; esac
command -v curl >/dev/null 2>&1 || { printf 'Install curl first.\n' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { printf 'Install tar first.\n' >&2; exit 1; }
umask 077
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$HOME_DIR" "$HOME_DIR/runtime" "$HOME/.local/bin"

download() { curl --fail --show-error --location --retry 3 --connect-timeout 20 "$1" -o "$2"; }
checksum() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
verify() {
  [ -n "$2" ] && [ "$(checksum "$1")" = "$2" ] || { printf 'Checksum verification failed: %s\n' "$1" >&2; exit 1; }
}

printf '\nTMCP · one-command setup · %s/%s\n\n' "$OS" "$ARCH"
NODE=""
if command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=16)?0:1)'; then NODE="$(command -v node)"; fi
if [ -z "$NODE" ]; then
  printf 'Installing a private Node.js 24 LTS runtime…\n'
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$TMP/node-sums.txt"
  NODE_FILE="$(awk -v suffix="-$OS-$ARCH.tar.gz" '$2 ~ (suffix "$") {print $2; exit}' "$TMP/node-sums.txt")"
  [ -n "$NODE_FILE" ] || { printf 'No Node.js build for this platform.\n' >&2; exit 1; }
  NODE_SUM="$(awk -v file="$NODE_FILE" '$2 == file {print $1}' "$TMP/node-sums.txt")"
  download "https://nodejs.org/dist/latest-v24.x/$NODE_FILE" "$TMP/node.tar.gz"
  verify "$TMP/node.tar.gz" "$NODE_SUM"
  tar -xzf "$TMP/node.tar.gz" -C "$HOME_DIR/runtime" --strip-components=1
  NODE="$HOME_DIR/runtime/bin/node"
fi
export PATH="$(dirname "$NODE"):$PATH"
if [ "$VERSION" = latest ]; then BASE="https://github.com/$REPO/releases/latest/download"; else BASE="https://github.com/$REPO/releases/download/$VERSION"; fi
download "$BASE/SHA256SUMS.txt" "$TMP/SHA256SUMS.txt"
download "$BASE/tmcp-core.tar.gz" "$TMP/tmcp-core.tar.gz"
EXPECTED="$(awk '$2 == "tmcp-core.tar.gz" {print $1}' "$TMP/SHA256SUMS.txt")"
verify "$TMP/tmcp-core.tar.gz" "$EXPECTED"

# Archives contain application files only, never .env or .mcp-tunnel.
tar -xzf "$TMP/tmcp-core.tar.gz" -C "$HOME_DIR"
npm --prefix "$HOME_DIR" ci --omit=dev --no-audit --no-fund
"$NODE" "$HOME_DIR/dist/src/cli.js" setup --root "${TMCP_ROOT:-$HOME}"
"$NODE" "$HOME_DIR/scripts/install-runtime.mjs"
mkdir -p "$HOME_DIR/bin"
printf '#!/bin/sh\nexec "%s" "%s/dist/src/cli.js" "$@"\n' "$NODE" "$HOME_DIR" > "$HOME_DIR/bin/tmcp"
chmod 755 "$HOME_DIR/bin/tmcp"
if [ "${TMCP_NO_PATH:-0}" != 1 ]; then
  ln -sf "$HOME_DIR/bin/tmcp" "$HOME/.local/bin/tmcp"
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *)
  LINE='export PATH="$HOME/.local/bin:$PATH"'
  for PROFILE in "$HOME/.profile" "$HOME/.zprofile"; do
    if [ ! -f "$PROFILE" ] || ! grep -Fq '.local/bin' "$PROFILE"; then printf '\n%s\n' "$LINE" >> "$PROFILE"; fi
  done ;;
  esac
fi
if [ "${TMCP_AUTOSTART:-0}" = 1 ]; then "$HOME_DIR/bin/tmcp" autostart on; fi
if [ "${TMCP_NO_START:-0}" != 1 ]; then "$HOME_DIR/bin/tmcp" start; fi
printf '\nInstalled. Open a new terminal and run: tmcp\nNow: %s/bin/tmcp\nAutostart is optional: tmcp autostart on\n' "$HOME_DIR"
