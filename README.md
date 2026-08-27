# omp — local coding agent

A terminal coding agent that runs against **your own LLM server**. No telemetry, no cloud dependency, no tracking. Point it at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp, or a remote API) and everything stays local.

---

## For users

### Install

You receive a single file (`omp-install.sh`) from your team. Run it:

```sh
bash omp-install.sh
```

It asks three things:

1. **Server URL** — e.g. `http://localhost:11434/v1` for Ollama
2. **API key** — press Enter if your server doesn't need one
3. **Model name** — e.g. `gemma4`, `llama3.1`, `deepseek-coder`

It tests the connection, installs the `omp` binary, and you're done.

```sh
omp
```

> Requires: macOS Apple Silicon. No Bun, Rust, or internet needed.

---

### Change LLM provider later

Inside any omp session:

```
/provider           — list current providers and models
/provider add       — create config with a starter template
/provider edit      — open config in your editor
/provider test      — test connectivity
/provider reload    — apply changes without restarting
```

Or edit `~/.omp/agent/models.yml` directly:

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

Multiple models:

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

Verify: `omp models ls` · Switch in session: `/model`

---

### What it does

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

### Memory & self-learning

Enabled by default. The agent:

- Records corrections when tool calls fail then succeed
- Stores lessons with the `learn` tool, weighted by importance
- Builds managed skills from repeated procedures
- Recalls relevant memories at session start
- All stored in `~/.omp/agent/memories/` — nothing leaves your machine

**Embeddings (optional):** improve recall with semantic search. Add to `~/.omp/agent/config.yml`:

```yaml
mnemopi:
  noEmbeddings: false
  embeddingApiUrl: "http://localhost:11434/v1"
  embeddingApiKey: "ollama"
  embeddingModel: "nomic-embed-text"
```

Without embeddings, memory uses keyword search — still works fine.

---

### Model roles (optional)

Route tasks to different models. Add to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: custom/gemma4
  smol: custom/gemma4
```

Available roles: `default`, `smol`, `slow`, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, `tiny`.

---

### Commands reference

```sh
omp                    # Interactive session
omp -p "prompt"        # Non-interactive (process and exit)
omp --continue         # Resume previous session
omp models ls          # List available models
omp perf               # Local performance report
omp stats              # Usage statistics dashboard
omp --help             # Full command reference
```

Inside a session:

| Command | What it does |
|---------|-------------|
| `/provider` | Manage LLM providers (add, edit, test, reload) |
| `/model` | Switch between configured models |
| `/settings` | Full settings UI |
| `/memory` | View/manage memory state |
| `/compact` | Compact conversation context |
| `/tools` | List available tools |
| `/help` | All commands |

---

## For developers

> This section is only for people building omp from source.

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.4
- Rust (nightly, via `rust-toolchain.toml`)

### Run from source

```sh
bun setup        # install deps + build native Rust addon
bun run dev      # start omp from source
```

### Build the installer

```sh
bun setup
bun run --cwd packages/coding-agent build
bash scripts/build-installer.sh
```

Output: `packages/coding-agent/dist/omp-install.sh` — one file you hand to users.

### Tests

```sh
bun run test     # run tests
bun run check    # lint + typecheck
bun run perf     # local performance report
```

After changing Rust crates: `bun run build:native`

More: [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) and [docs/](docs/).

---

## License

MIT — see [LICENSE](LICENSE).
