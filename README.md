# omp — local coding agent

A terminal coding agent that runs against **your own LLM server**. Fully offline after install. No telemetry, no cloud, no tracking.

---

## Install

```sh
git clone https://github.com/simpletoolsindia/oh-my-pi-enterprise.git
cd oh-my-pi-enterprise
bash install.sh
```

The script does everything automatically:

1. Installs Bun (if needed)
2. Installs Rust (if needed)
3. Builds the `omp` binary
4. Asks for your LLM server (URL, key, model)
5. Tests the connection
6. Adds `omp` to your PATH

After install, **everything runs offline** — no internet needed to use omp.

```sh
omp
```

> Requires: macOS Apple Silicon + internet (first run only for build tools)

---

## Change LLM provider anytime

Inside any omp session:

```
/provider           — show current config
/provider add       — create config from template
/provider edit      — open config in editor
/provider test      — test server connectivity
/provider reload    — apply changes without restart
```

Or edit `~/.omp/agent/models.yml` directly.

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
omp                  # start interactive session
omp -p "prompt"      # non-interactive (process and exit)
omp --continue       # resume last session
omp models ls        # list models
omp perf             # performance report
omp --help           # all commands
```

Session commands: `/provider`, `/model`, `/settings`, `/memory`, `/tools`, `/help`

---

## Memory (enabled by default)

The agent remembers across sessions — learns from errors, stores lessons, builds skills. All local SQLite, nothing sent anywhere.

Optional: add embeddings for better recall. Edit `~/.omp/agent/config.yml`:

```yaml
mnemopi:
  noEmbeddings: false
  embeddingApiUrl: "http://localhost:11434/v1"
  embeddingApiKey: "ollama"
  embeddingModel: "nomic-embed-text"
```

---

## License

MIT
