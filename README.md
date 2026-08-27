# omp — self-hosted coding agent

A terminal coding agent, locked down for internal/enterprise use: **one OpenAI-compatible provider you point it at**, no telemetry, no update checks, no remote tracking, no other API ever called. Code understanding, memory, and subagents all run locally against your own model server.

Fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) (itself a fork of [Pi](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/mariozechner)), stripped down and re-pointed at a single self-hosted provider.

---

## Quick start

Someone on your team builds `omp-install.sh` once (see [Building the installer](#building-the-installer)) and hands you the file. To install:

```sh
bash omp-install.sh
```

The installer walks you through everything:

1. **Installs the binary** to `~/.local/bin/omp` and confirms it starts.
2. **Asks for your model server** — URL, API key, and one or more model names. It tests the connection immediately so a typo surfaces now, not on your first prompt.
3. **Asks about memory embeddings** (optional — see [Memory embeddings](#memory-embeddings)).
4. **Adds `~/.local/bin` to your `PATH`** if it isn't already there.

Then:

```sh
omp
```

Re-running the installer is safe — if `~/.omp/agent/models.yml` already exists it's left untouched. To redo setup, delete that file and run it again.

> Currently supports **macOS on Apple Silicon (darwin-arm64)**.

---

## Configuring models

Everything lives in `~/.omp/agent/models.yml`:

```yaml
providers:
  custom:
    baseUrl: https://your-server.internal/v1
    apiKey: your-api-key
    api: openai-completions
    models:
      - id: your-model-id
        name: Friendly Name
        contextWindow: 128000
        maxTokens: 32000
      - id: another-model-id
        name: Another Model
        contextWindow: 200000
        maxTokens: 32000
```

`models` is a list — add as many as your server exposes; each becomes its own selectable model. Verify with `omp models ls`, then pick one with `/model` inside a session.

Roles route work by intent: `default` for normal turns, `smol` for cheap subagent fan-out, `slow` for deep reasoning, `plan`, `commit`, `vision`, `designer`, `task`, `advisor`, `tiny`. You don't have to configure any of them — anything unset falls back to an available model. To pin one anyway, add to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: custom/your-model-id
  smol: custom/a-smaller-faster-model
```

---

## Memory embeddings

The agent remembers lessons across sessions (see [Self-learning](#self-learning)). How it *finds* them again depends on whether embeddings are configured:

| | How recall works | Needs |
| --- | --- | --- |
| **Embeddings off** (default) | Local full-text keyword search | Nothing |
| **Embeddings on** | Semantic search — finds a lesson even when worded differently from your query | An OpenAI-compatible `/v1/embeddings` endpoint |

**You do not need embeddings.** With them off, memory still works — it just matches on words rather than meaning. Nothing crashes, and no large model download happens.

### Turning embeddings on or off in the TUI

Inside a session, type:

```
/settings
```

Go to the **Memory** tab → **Mnemopi** group. The relevant settings:

| Setting | What it does |
| --- | --- |
| **Mnemopi Disable Embeddings** | `true` = keyword search only. `false` = use the endpoint below. |
| **Mnemopi Embedding API URL** | Your `/v1`-style base URL. Can be a **different server** from your chat model. |
| **Mnemopi Embedding API Key** | Key for that endpoint. |
| **Mnemopi Embedding Model** | e.g. `text-embedding-3-small`, `nomic-embed-text`. |

Changes save immediately. (If the Memory tab is empty, memory is off entirely — set **Memory Backend** to `mnemopi` first.)

### Or configure it in a file

`~/.omp/agent/config.yml`:

```yaml
mnemopi:
  noEmbeddings: false                              # true = keyword search only
  embeddingApiUrl: "https://embeddings.internal/v1" # may differ from your chat server
  embeddingApiKey: "your-key"
  embeddingModel: "text-embedding-3-small"
```

To turn embeddings off, that's the whole config:

```yaml
mnemopi:
  noEmbeddings: true
```

**If the endpoint is wrong, unreachable, or removed later, the agent does not crash** — it logs and falls back to keyword search. You can fix it whenever.

---

## Self-learning

The agent builds project- and preference-specific memory over time, entirely on disk, via [mnemopi](docs/memory.md):

- **Learns from mistakes.** When a tool call or approach fails and a correction works, it records the failure *and* the fix with the `learn` tool, weighted higher than a routine note so it outranks ordinary memories next time it's relevant.
- **Captures on friction, not volume.** A capture turn triggers after a turn where something actually errored — not merely a long turn — so what gets stored is corrective rather than generic.
- **Reusable procedures become skills.** Repeatable workflows get written as managed skills that resurface automatically in later sessions.
- **Reinforces on repetition.** Re-learning the same lesson (in any session, and past differences in wording or punctuation) strengthens the existing memory instead of creating a duplicate.
- **Automatic.** Recall runs at session start and around context compaction; retention happens as the conversation progresses. No slash command needed for the common case.

All local SQLite under `~/.omp/agent/memories/`. Nothing is sent anywhere.

---

## Local code graph

An in-process code graph built on the bundled native tree-sitter engine and `bun:sqlite` — no external indexer, no network:

- Covers **TypeScript/JavaScript/TSX** and **Python** definitions and call sites, plus each format's native reuse construct for **YAML** (anchors/aliases), **CSS** (custom properties / `var()`), **HTML** (`id` ↔ `href`/`for`/`aria-labelledby`), and **Jinja** (macros).
- Answers "who calls this", "what does this depend on", "what breaks if I change this" by querying the graph instead of grepping.
- Indexes on first launch per project, stored at `.omp/codegraph.db`. On a large repo this takes a while (~40s for ~4,000 files) — **press `Esc` to skip it** and drop straight into the session; the index is then rebuilt the first time the tool is actually used.

Full reference and honest limitations (name/AST-based, not a compiler) in [docs/tools/codegraph.md](docs/tools/codegraph.md).

---

## Subagents

Large tasks are decomposed and fanned out to subagents rather than run as one long linear turn. Each gets a purpose-scoped toolset and its own context budget, then reports back a summary. See [docs/task-agent-discovery.md](docs/task-agent-discovery.md).

---

## What else is in the box

The provider layer and remote-facing features were cut; the coding-agent surface was not:

- **Editing** — line- and hash-anchored edits, AST-aware structural edits (`ast_edit`, `ast_grep`), conflict-aware writes, checkpoints.
- **Shell** — persistent interactive bash with PTY support.
- **LSP & DAP** — real language-server operations and a real debugger, not text heuristics.
- **Git & GitHub** — commit/PR/review workflows with `gh` wired in.
- **Review** — structured code review with prioritized findings and a verdict.
- **Also**: security scanning, PDF/SQLite/archive reading, image inspection, browser automation, computer use, plan mode, vibe mode.
- **Extensibility** — skills, MCP servers, hooks, custom slash commands, extensions.

Every setting is documented in-app under `/settings` and in [docs/settings.md](docs/settings.md).

---

## Building the installer

Requires the dev toolchain (Bun + Rust):

```sh
bun setup                                   # workspaces + native addon
bun run --cwd packages/coding-agent build   # compile the omp binary
bash scripts/build-installer.sh             # bundle into one self-extracting file
```

Produces `packages/coding-agent/dist/omp-install.sh` — a single file with the binary embedded, needing no internet access and no artifact server on the target machine.

## Development

```sh
bun setup   # workspaces + native Rust/N-API addon
bun dev     # run from source
```

Re-run `bun run build:native` after changing Rust crates. See [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) and [docs/](docs/).

## License

MIT — see [LICENSE](LICENSE).
