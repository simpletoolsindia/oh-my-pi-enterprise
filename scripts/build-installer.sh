#!/usr/bin/env bash
# Assembles a single self-extracting installer from the compiled omp binary.
#
# Build first:
#   bun setup
#   bun run --cwd packages/coding-agent build
#
# Then:
#   bash scripts/build-installer.sh
#
# Output: packages/coding-agent/dist/omp-install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="$REPO_ROOT/packages/coding-agent/dist/omp"
OUTPUT_PATH="$REPO_ROOT/packages/coding-agent/dist/omp-install.sh"

if [ ! -f "$BINARY_PATH" ]; then
    echo "error: binary not found at $BINARY_PATH" >&2
    echo "Build first: bun run --cwd packages/coding-agent build" >&2
    exit 1
fi

HEADER_PATH="$(mktemp)"
trap 'rm -f "$HEADER_PATH"' EXIT

cat > "$HEADER_PATH" <<'INSTALLER_HEADER'
#!/usr/bin/env bash
# omp installer — self-extracting, no internet required.
set -euo pipefail

# --- Platform check ---
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "Error: This installer only supports macOS Apple Silicon (darwin-arm64)." >&2
    echo "Detected: $OS/$ARCH" >&2
    exit 1
fi

# --- Extract binary ---
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$INSTALL_DIR"
TARGET="$INSTALL_DIR/omp"

SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
sed -n '/^__PAYLOAD_BELOW__$/,$p' "$SELF" | tail -n +2 | base64 -d > "$TARGET"
chmod +x "$TARGET"

if ! VERSION="$("$TARGET" --version 2>&1)"; then
    echo "Error: omp binary cannot start:" >&2
    echo "  $VERSION" >&2
    exit 1
fi

echo ""
echo "✓ omp installed to $TARGET ($VERSION)"

# --- Provider setup ---
MODELS_DIR="$HOME/.omp/agent"
MODELS_FILE="$MODELS_DIR/models.yml"

yq() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "$s"
}

if [ -f "$MODELS_FILE" ]; then
    echo ""
    echo "Config exists at $MODELS_FILE — skipping setup."
    echo "(Delete that file and re-run to reconfigure.)"
else
    echo ""
    echo "── LLM Provider Setup ──"
    echo ""
    echo "Point omp at any OpenAI-compatible server (Ollama, LM Studio,"
    echo "vLLM, llama.cpp, or a remote API). All model calls go there only."
    echo ""

    # URL
    read -r -p "Server URL (e.g. http://localhost:11434/v1): " URL
    URL="${URL%/}"

    # API key
    read -r -s -p "API key (press Enter if none): " KEY
    echo ""
    KEY="${KEY:-ollama}"

    # Test connection
    printf "Testing connection... "
    if curl -fsS --max-time 8 -H "Authorization: Bearer $KEY" "$URL/models" >/dev/null 2>&1; then
        echo "✓ connected"
    else
        echo "✗ could not reach $URL/models"
        echo "  (Continuing anyway — fix the URL/key in $MODELS_FILE later.)"
    fi

    # Model name
    echo ""
    read -r -p "Model name (as your server lists it, e.g. gemma4): " MODEL
    MODEL="${MODEL:-default}"

    # Write config
    mkdir -p "$MODELS_DIR"
    cat > "$MODELS_FILE" <<EOF
providers:
  custom:
    baseUrl: $(yq "$URL")
    apiKey: $(yq "$KEY")
    api: openai-completions
    models:
      - id: $(yq "$MODEL")
        name: $(yq "$MODEL")
        contextWindow: 128000
        maxTokens: 8192
EOF
    echo ""
    echo "✓ Wrote $MODELS_FILE"
fi

# --- PATH setup ---
echo ""
case ":$PATH:" in
    *":$INSTALL_DIR:"*) echo "Ready — run 'omp' to start." ;;
    *)
        RC=""
        case "$(basename "${SHELL:-}")" in
            zsh)  RC="$HOME/.zshrc" ;;
            bash) RC="$HOME/.bashrc" ;;
        esac
        if [ -n "$RC" ]; then
            printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$RC"
            echo "Added $INSTALL_DIR to PATH in $RC"
            echo "Run: source $RC && omp"
        else
            echo "Add $INSTALL_DIR to your PATH, then run 'omp'."
        fi
        ;;
esac
echo ""
exit 0
__PAYLOAD_BELOW__
INSTALLER_HEADER

base64 < "$BINARY_PATH" >> "$HEADER_PATH"

mv "$HEADER_PATH" "$OUTPUT_PATH"
trap - EXIT
chmod +x "$OUTPUT_PATH"

echo "Installer: $OUTPUT_PATH ($(du -h "$OUTPUT_PATH" | cut -f1))"
