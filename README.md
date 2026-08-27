# omp — local coding agent

A terminal coding agent that runs against **your own LLM server**. Fully offline. No telemetry, no cloud, no tracking.

---

## Install (no internet needed)

```sh
bash install.sh
```

It does 3 things:

1. Copies the `omp` binary to `~/.local/bin/`
2. Asks for your LLM server (URL, key, model)
3. Adds `omp` to your PATH

Then:

```sh
omp
```

> Works on macOS Apple Silicon. No internet, no Bun, no Rust, no npm needed.

---

## How your team ships this

One developer (with internet) builds once:

```sh
bun setup
bun run --cwd packages/coding-agent build
```

Then shares this repo (with the `packages/coding-agent/dist/omp` binary included). Everyone else just runs `bash install.sh`.

---

## Change LLM provider anytime

Inside any omp session:

```
/provider           — show current config
/provider edit      — open config in editor
/provider test      — test server connectivity
/provider reload    — apply changes without restart
```

---

## Features

| Feature | Description |
|---------|-------------|
| **Code editing** | AST-aware edits, conflict-aware writes, checkpoints |
| **Shell** | Persistent bash with PTY |
| **Memory** | Learns from mistakes, remembers across sessions |
| **Code graph** | Symbol/call graph (TS, Python, YAML, CSS, HTML) |
| **Subagents** | Parallel task workers |
| **LSP & DAP** | Language server + debugger |
| **Git** | Commit, PR, review with `gh` |
| **Search** | Native grep, glob, fuzzy-find, AST matching |
| **Browser** | Puppeteer automation |
| **Extensions** | Skills, MCP servers, hooks, custom commands |

---

## Commands

```sh
omp                  # start session
omp -p "prompt"      # non-interactive
omp --continue       # resume last session
omp models ls        # list models
omp perf             # performance report
omp --help           # all commands
```

Session: `/provider`, `/model`, `/settings`, `/memory`, `/tools`, `/help`

---

## Memory (enabled by default)

Learns from errors, stores lessons, builds skills. All local SQLite.

Optional embeddings for better recall — add to `~/.omp/agent/config.yml`:

```yaml
mnemopi:
  noEmbeddings: false
  embeddingApiUrl: "http://localhost:11434/v1"
  embeddingApiKey: "ollama"
  embeddingModel: "nomic-embed-text"
```

---

## For developers (building from source)

```sh
bun setup                                    # install deps + native addon
bun run dev                                  # run from source
bun run --cwd packages/coding-agent build    # compile binary
bun run test                                 # run tests
```

---

## License

MIT
