#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# omp installer — ONE script, installs everything, works offline after.
#
# Usage:
#   bash install.sh
#
# After this finishes, just run: omp
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

# --- Install Bun ---
echo "▶ [1/5] Checking Bun..."
if command -v bun &>/dev/null; then
    echo "  ✓ Bun $(bun --version)"
else
    echo "  Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    echo "  ✓ Bun installed"
fi

# --- Install Rust ---
echo "▶ [2/5] Checking Rust..."
if command -v rustc &>/dev/null; then
    echo "  ✓ Rust $(rustc --version | awk '{print $2}')"
else
    echo "  Installing Rust (nightly)..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
    source "$HOME/.cargo/env"
    echo "  ✓ Rust installed"
fi

# --- Build ---
echo "▶ [3/5] Building omp (first time takes a few minutes)..."
cd "$REPO_DIR"
bun setup 2>&1 | tail -3
bun run --cwd packages/coding-agent build 2>&1 | tail -3

BINARY="$REPO_DIR/packages/coding-agent/dist/omp"
if [ ! -f "$BINARY" ]; then
    echo "Error: Build failed." >&2
    exit 1
fi

# --- Install binary ---
echo "▶ [4/5] Installing binary..."
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"
cp "$BINARY" "$INSTALL_DIR/omp"
chmod +x "$INSTALL_DIR/omp"
echo "  ✓ Installed to $INSTALL_DIR/omp"

# --- LLM Provider ---
echo "▶ [5/5] LLM Provider Setup"

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
        echo "✗ can't reach server (fix later with /provider edit in omp)"
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
    echo "  ✓ Saved to $MODELS_FILE"
fi

# --- PATH ---
echo ""
case ":$PATH:" in
    *":$INSTALL_DIR:"*)
        echo "═══════════════════════════════════"
        echo "  Done! Run:  omp"
        echo "═══════════════════════════════════"
        ;;
    *)
        RC=""
        case "$(basename "${SHELL:-}")" in
            zsh)  RC="$HOME/.zshrc" ;;
            bash) RC="$HOME/.bashrc" ;;
        esac
        if [ -n "$RC" ]; then
            printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$RC"
            echo "═══════════════════════════════════"
            echo "  Done! Run:"
            echo "    source $RC"
            echo "    omp"
            echo "═══════════════════════════════════"
        else
            echo "  Add $INSTALL_DIR to PATH, then run: omp"
        fi
        ;;
esac
echo ""
