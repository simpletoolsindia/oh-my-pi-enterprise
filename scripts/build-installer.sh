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
CONFIG_FILE="$MODELS_DIR/config.yml"

# Escapes `\` and `"` so an interpolated value is safe inside a YAML
# double-quoted scalar (server URLs/keys/model ids can contain `:` or `#`,
# which break unquoted YAML scalars).
yaml_quote() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    printf '"%s"' "$s"
}

if [ -f "$MODELS_FILE" ]; then
    echo "A config already exists at $MODELS_FILE — leaving it untouched."
    echo "(To redo setup, delete that file and re-run this installer.)"
else
    echo "Set up your custom OpenAI-compatible model provider."
    echo "(Every model call goes here and nowhere else. omp never phones home.)"
    echo ""

    while :; do
        read -r -p "Server URL (e.g. https://api.example.com/v1): " PROVIDER_URL
        read -r -s -p "API key: " PROVIDER_KEY
        echo ""

        printf '%s' "Testing connection... "
        if curl -fsS --max-time 10 -H "Authorization: Bearer $PROVIDER_KEY" "$PROVIDER_URL/models" >/dev/null 2>&1; then
            echo "connected."
            break
        fi
        echo "could not reach $PROVIDER_URL/models with that key."
        read -r -p "Try a different URL/key? [Y/n]: " RETRY
        case "$RETRY" in
            [Nn]*) echo "Continuing anyway — you can fix this later by editing $MODELS_FILE." ; break ;;
            *) continue ;;
        esac
    done

    MODEL_IDS=()
    while :; do
        read -r -p "Model name (as your server calls it): " MODEL_ID
        if [ -z "$MODEL_ID" ]; then
            echo "Model name cannot be empty." >&2
            continue
        fi
        MODEL_IDS+=("$MODEL_ID")
        read -r -p "Add another model? [y/N]: " ADD_MORE
        case "$ADD_MORE" in
            [Yy]*) continue ;;
            *) break ;;
        esac
    done

    mkdir -p "$MODELS_DIR"
    {
        echo "providers:"
        echo "  custom:"
        echo "    baseUrl: $(yaml_quote "$PROVIDER_URL")"
        echo "    apiKey: $(yaml_quote "$PROVIDER_KEY")"
        echo "    api: openai-completions"
        echo "    models:"
        for MODEL_ID in "${MODEL_IDS[@]}"; do
            echo "      - id: $(yaml_quote "$MODEL_ID")"
            echo "        name: $(yaml_quote "$MODEL_ID")"
            echo "        api: openai-completions"
        done
    } > "$MODELS_FILE"
    echo "Wrote $MODELS_FILE with ${#MODEL_IDS[@]} model(s)."

    # --- Memory embeddings (optional, configured independently of chat) ------
    # omp's memory works either way: with embeddings it can recall a lesson
    # phrased differently from your query (semantic); without them it falls
    # back to local full-text search (keyword). Declining also skips a large
    # on-demand download of the on-device embedding runtime, which is why the
    # "no" branch writes the setting explicitly rather than leaving it unset.
    echo ""
    echo "Memory embeddings (optional) — improves how well the agent recalls past lessons."
    echo "Needs an OpenAI-compatible /v1/embeddings endpoint; it can be a different"
    echo "server than the chat model above. Answer 'n' to use local keyword search instead."
    read -r -p "Configure an embeddings endpoint? [y/N]: " WANT_EMB
    case "$WANT_EMB" in
        [Yy]*)
            read -r -p "Embeddings URL [$PROVIDER_URL]: " EMB_URL
            EMB_URL="${EMB_URL:-$PROVIDER_URL}"
            read -r -s -p "Embeddings API key (blank = reuse the key above): " EMB_KEY
            echo ""
            EMB_KEY="${EMB_KEY:-$PROVIDER_KEY}"
            read -r -p "Embeddings model (e.g. text-embedding-3-small): " EMB_MODEL

            printf '%s' "Testing embeddings endpoint... "
            if curl -fsS --max-time 15 -X POST "$EMB_URL/embeddings" \
                -H "Authorization: Bearer $EMB_KEY" \
                -H "Content-Type: application/json" \
                -d "{\"model\":\"$EMB_MODEL\",\"input\":\"omp installer connectivity probe\"}" \
                >/dev/null 2>&1; then
                echo "connected."
            else
                echo "could not reach $EMB_URL/embeddings with that key/model."
                echo "Saving it anyway — memory falls back to keyword search until it works,"
                echo "and you can fix it later in omp via /settings → Memory."
            fi

            mkdir -p "$MODELS_DIR"
            {
                echo "mnemopi:"
                echo "  noEmbeddings: false"
                echo "  embeddingApiUrl: $(yaml_quote "$EMB_URL")"
                echo "  embeddingApiKey: $(yaml_quote "$EMB_KEY")"
                echo "  embeddingModel: $(yaml_quote "$EMB_MODEL")"
            } >> "$CONFIG_FILE"
            echo "Wrote embeddings config to $CONFIG_FILE"
            ;;
        *)
            mkdir -p "$MODELS_DIR"
            {
                echo "mnemopi:"
                echo "  noEmbeddings: true"
            } >> "$CONFIG_FILE"
            echo "Embeddings off — memory will use local keyword search."
            echo "You can turn them on later in omp via /settings → Memory."
            ;;
    esac
fi

echo ""
case ":$PATH:" in
    *":$INSTALL_DIR:"*) echo "All set — run 'omp' to get started!" ;;
    *)
        SHELL_RC=""
        case "$(basename "${SHELL:-}")" in
            zsh) SHELL_RC="$HOME/.zshrc" ;;
            bash) SHELL_RC="$HOME/.bashrc" ;;
        esac
        if [ -n "$SHELL_RC" ]; then
            printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$SHELL_RC"
            echo "Added $INSTALL_DIR to PATH in $SHELL_RC."
            echo "Restart your terminal (or run: source $SHELL_RC), then run 'omp'."
        else
            echo "Add $INSTALL_DIR to your PATH, then run 'omp'."
        fi
        ;;
esac

exit 0
__PAYLOAD_BELOW__
INSTALLER_HEADER

base64 < "$BINARY_PATH" >> "$HEADER_PATH"

mv "$HEADER_PATH" "$OUTPUT_PATH"
trap - EXIT
chmod +x "$OUTPUT_PATH"

echo "Installer written to $OUTPUT_PATH ($(du -h "$OUTPUT_PATH" | cut -f1))"
