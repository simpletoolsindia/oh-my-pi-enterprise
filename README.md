# omp — local coding agent

A terminal coding agent that runs against **your own LLM server**. No telemetry, no cloud dependency, no tracking. Point it at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp, or a remote API) and everything stays local.

---

## Install

```sh
bash omp-install.sh
```

The installer asks three things:

1. **Server URL** — e.g. `http://localhost:11434/v1` for Ollama
2. **API key** — press Enter if your server doesn't need one
3. **Model name** — e.g. `gemma4`, `llama3.1`, `deepseek-coder`

It tests the connection, writes the config, and adds `omp` to your PATH.

Then:

```sh
omp
```

> macOS Apple Silicon (darwin-arm64) only.

---

## Setup without the installer

If you're running from source or want to configure manually:

**Option A — Interactive UI:**

```sh
omp
# Inside the session, type:  /settings
# Go to Providers tab → configure your server URL, key, and model
```

**Option B — Config file:**

Create `~/.omp/agent/models.yml`:

```yaml
providers:
  custom:
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
    api: openai-completions
    models:
      - id: gemma4
        name: Gemma 4
        contextWindow: 128000
        maxTokens: 8192
```

Add multiple models if your server exposes them:

```yaml
    models:
      - id: gemma4
        name: Gemma 4
        contextWindow: 128000
        maxTokens: 8192
      - id: llama3.1
        name: Llama 3.1
        contextWindow: 128000
        maxTokens: 4096
```

Verify: `omp models ls`

Switch models inside a session: `/model`

---

## What it does

| Feature | Description |
|---------|-------------|
| **Code editing** | Line/hash-anchored edits, AST structural edits, conflict-aware writes |
| **Shell** | Persistent interactive bash with PTY |
| **Memory** | Learns from mistakes, remembers across sessions (local SQLite) |
| **Code graph** | In-process symbol/call graph (TS, Python, YAML, CSS, HTML, Jinja) |
| **Subagents** | Fans out large tasks to parallel workers |
| **LSP & DAP** | Real language-server and debugger integration |
| **Git** | Commit, PR, review workflows with `gh` |
| **Search** | Native grep, glob, fuzzy-find, AST pattern matching |
| **Browser** | Puppeteer automation, computer use |
| **Extensibility** | Skills, MCP servers, hooks, custom commands, extensions |

---

## Memory & self-learning

Enabled by default. The agent:

- Records corrections when tool calls fail then succeed
- Stores lessons with the `learn` tool, weighted by importance
- Builds managed skills from repeated procedures
- Recalls relevant memories at session start
- All stored in `~/.omp/agent/memories/` — nothing leaves your machine

**Embeddings (optional):** improve recall quality with semantic search. Configure via `/settings → Memory → Mnemopi` or in `~/.omp/agent/config.yml`:

```yaml
mnemopi:
  noEmbeddings: false
  embeddingApiUrl: "http://localhost:11434/v1"
  embeddingApiKey: "ollama"
  embeddingModel: "nomic-embed-text"
```

Without embeddings, memory falls back to keyword search — still works, just matches words not meaning.

---

## Model roles (optional)

Route different tasks to different models. Add to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: custom/gemma4
  smol: custom/gemma4
```

Available roles: `default`, `smol`, `slow`, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, `tiny`. Unset roles fall back to any available model.

---

## Commands

```sh
omp                    # Interactive session
omp -p "prompt"        # Non-interactive (process and exit)
omp --continue         # Resume previous session
omp models ls          # List available models
omp perf               # Local performance report
omp stats              # Usage statistics dashboard
omp --help             # Full command reference
```

Inside a session: `/settings`, `/model`, `/memory`, `/compact`, `/tools`, `/help`

---

## Building the installer

Requires Bun + Rust:

```sh
bun setup
bun run --cwd packages/coding-agent build
bash scripts/build-installer.sh
```

Produces `packages/coding-agent/dist/omp-install.sh` — one file, no internet needed on the target machine.

---

## Development

```sh
bun setup        # Install dependencies + build native Rust addon
bun run dev      # Run from source
bun run test     # Run tests
bun run check    # Lint + typecheck
```

After changing Rust crates: `bun run build:native`

See [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) and [docs/](docs/).

---

## License

MIT — see [LICENSE](LICENSE).
