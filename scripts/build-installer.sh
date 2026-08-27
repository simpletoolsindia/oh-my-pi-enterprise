#!/usr/bin/env bash
# Assembles a single self-extracting installer file from the already-built
# `omp` binary at packages/coding-agent/dist/omp. Run the build first:
#   bun run --cwd packages/coding-agent build
# Then:
#   bash scripts/build-installer.sh
# Produces packages/coding-agent/dist/omp-install.sh — one file that contains
# both the installer logic and the binary payload (base64-encoded), so it can
# be copied and run on a target machine with no internet access and no
# internal artifact server required.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="$REPO_ROOT/packages/coding-agent/dist/omp"
OUTPUT_PATH="$REPO_ROOT/packages/coding-agent/dist/omp-install.sh"

if [ ! -f "$BINARY_PATH" ]; then
    echo "error: binary not found at $BINARY_PATH" >&2
    echo "Run the build first: bun run --cwd packages/coding-agent build" >&2
    exit 1
fi

# Only darwin-arm64 is supported by this pass; the compiled binary at
# dist/omp is whatever `bun run build` just produced for the host machine.
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "warning: built on $OS/$ARCH, not darwin/arm64 — the assembled installer will only work on the platform the binary was actually compiled for." >&2
fi

HEADER_PATH="$(mktemp)"
trap 'rm -f "$HEADER_PATH"' EXIT

cat > "$HEADER_PATH" <<'INSTALLER_HEADER'
#!/usr/bin/env bash
# Self-extracting omp installer. This file contains both this header script
# and the compiled omp binary (base64-encoded, appended after the
# __PAYLOAD_BELOW__ marker line). Run it directly: `bash omp-install.sh`.
set -euo pipefail

OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "This installer only supports macOS on Apple Silicon (darwin-arm64)." >&2
    echo "Detected: $OS/$ARCH" >&2
    exit 1
fi

INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/omp"

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
sed -n '/^__PAYLOAD_BELOW__$/,$p' "$SELF" | tail -n +2 | base64 -d > "$TARGET"
chmod +x "$TARGET"

if ! SMOKE_OUTPUT="$("$TARGET" --version 2>&1)"; then
    echo "" >&2
    echo "omp was installed to $TARGET but cannot start:" >&2
    echo "$SMOKE_OUTPUT" | sed 's/^/    /' >&2
    exit 1
fi

echo ""
echo "omp installed to $TARGET ($SMOKE_OUTPUT)"
echo ""

MODELS_DIR="$HOME/.omp/agent"
MODELS_FILE="$MODELS_DIR/models.yml"

if [ -f "$MODELS_FILE" ]; then
    echo "A config already exists at $MODELS_FILE — leaving it untouched."
else
    echo "Set up your custom OpenAI-compatible model provider."
    read -r -p "Server URL (e.g. https://api.example.com/v1): " PROVIDER_URL
    read -r -p "Model name (as your server calls it): " PROVIDER_MODEL
    read -r -s -p "API key: " PROVIDER_KEY
    echo ""

    mkdir -p "$MODELS_DIR"
    cat > "$MODELS_FILE" <<EOF
providers:
  custom:
    baseUrl: $PROVIDER_URL
    apiKey: $PROVIDER_KEY
    api: openai-completions
    models:
      - id: $PROVIDER_MODEL
        name: $PROVIDER_MODEL
        api: openai-completions
EOF
    echo "Wrote $MODELS_FILE"
fi

echo ""
case ":$PATH:" in
    *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
    *) echo "Add $INSTALL_DIR to your PATH, then run 'omp'." ;;
esac

exit 0
__PAYLOAD_BELOW__
INSTALLER_HEADER

base64 < "$BINARY_PATH" >> "$HEADER_PATH"

mv "$HEADER_PATH" "$OUTPUT_PATH"
trap - EXIT
chmod +x "$OUTPUT_PATH"

echo "Installer written to $OUTPUT_PATH ($(du -h "$OUTPUT_PATH" | cut -f1))"
