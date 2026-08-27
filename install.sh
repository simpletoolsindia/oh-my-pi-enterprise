#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# omp installer — ONE script, no internet needed.
#
# Usage:
#   bash install.sh
#
# This script installs the pre-built omp binary, asks for your
# LLM server, and you're done. Works fully offline.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       omp — local coding agent       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# --- Platform check ---
OS="$(uname -s)"
ARCH="$(uname -m)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
    echo "Error: Only macOS Apple Silicon supported (got $OS/$ARCH)." >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY="$REPO_DIR/packages/coding-agent/dist/omp"
BINARY_GZ="$REPO_DIR/packages/coding-agent/dist/omp.gz"

# Decompress if needed
if [ ! -f "$BINARY" ] && [ -f "$BINARY_GZ" ]; then
    echo "  Decompressing binary..."
    gunzip -k "$BINARY_GZ"
    chmod +x "$BINARY"
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: Binary not found at:" >&2
    echo "  $BINARY (or $BINARY_GZ)" >&2
    echo "" >&2
    echo "A developer must build it first:" >&2
    echo "  bun setup && bun run --cwd packages/coding-agent build" >&2
    exit 1
fi

# --- Install binary ---
echo "▶ [1/3] Installing binary..."
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
cp "$BINARY" "$INSTALL_DIR/omp"
chmod +x "$INSTALL_DIR/omp"

if ! VERSION="$("$INSTALL_DIR/omp" --version 2>&1)"; then
    echo "  Error: binary cannot start." >&2
    exit 1
fi
echo "  ✓ omp installed ($VERSION)"

# --- LLM Provider ---
echo "▶ [2/3] LLM Provider Setup"

MODELS_DIR="$HOME/.omp/agent"
MODELS_FILE="$MODELS_DIR/models.yml"

yq() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }

if [ -f "$MODELS_FILE" ]; then
    echo "  Config exists — skipping. (Delete $MODELS_FILE to redo.)"
else
    echo ""
    echo "  Point omp at your OpenAI-compatible LLM server."
    echo "  Examples:"
    echo "    Ollama:    http://localhost:11434/v1"
    echo "    LM Studio: http://localhost:1234/v1"
    echo "    vLLM:      http://localhost:8000/v1"
    echo ""
    read -r -p "  Server URL: " URL
    URL="${URL%/}"
    read -r -s -p "  API key (Enter if none): " KEY
    echo ""
    KEY="${KEY:-ollama}"
    read -r -p "  Model name (e.g. gemma4): " MODEL
    MODEL="${MODEL:-gemma4}"

    printf "  Testing... "
    if curl -fsS --max-time 8 -H "Authorization: Bearer $KEY" "$URL/models" >/dev/null 2>&1; then
        echo "✓ connected"
    else
        echo "✗ can't reach server (fix later with /provider edit)"
    fi

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
    echo "  ✓ Saved"
fi

# --- PATH ---
echo "▶ [3/3] PATH setup"
case ":$PATH:" in
    *":$INSTALL_DIR:"*)
        ;;
    *)
        RC=""
        case "$(basename "${SHELL:-}")" in
            zsh)  RC="$HOME/.zshrc" ;;
            bash) RC="$HOME/.bashrc" ;;
        esac
        if [ -n "$RC" ]; then
            printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$RC"
            echo "  ✓ Added to PATH in $RC"
        else
            echo "  Add $INSTALL_DIR to your PATH manually."
        fi
        ;;
esac

echo ""
echo "═══════════════════════════════════════"
echo "  Done! Run:  omp"
echo "═══════════════════════════════════════"
echo ""
echo "  Change provider later:  /provider edit"
echo "  Switch models:          /model"
echo "  All settings:           /settings"
echo ""
