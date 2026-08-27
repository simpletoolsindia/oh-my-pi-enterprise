# omp — self-hosted coding agent

A terminal coding agent, locked down for internal/enterprise use: **one OpenAI-compatible provider you point it at**, no telemetry, no update checks, no remote tracking, no other API ever called. Everything — code understanding, memory, subagents — runs locally against your own model server.

Fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) (itself a fork of [Pi](https://github.com/badlogic/pi-mono) by [@mariozechner](https://github.com/mariozechner)), stripped down and re-pointed at a single self-hosted provider.

## What's different from upstream

- **One provider, not sixty.** No OAuth logins, no per-provider API keys, no provider marketplace/catalog fetched from anywhere. You configure exactly one OpenAI-compatible `baseUrl` + `apiKey`, with as many models under it as your server exposes.
- **No remote anything.** No usage/telemetry reporting, no version/update checks, no release-notes fetch, no crash reporting. Nothing phones home.
- **Fully offline install.** The self-extracting installer embeds the compiled binary; it needs no internet access and no artifact server to run.
- **Local code understanding.** A built-in code graph indexes your repo (TypeScript/JavaScript/TSX, Python, YAML, CSS, HTML, Jinja) using the bundled native tree-sitter engine and a local SQLite index — no external CLI, no network call.
- **Local, persistent self-learning.** The agent remembers durable facts, project conventions, and corrected mistakes across sessions in a local memory store, and reuses them automatically in future conversations — see [Self-learning](#self-learning) below.

## Install

### Quick start (end users)

Someone on your team already built `omp-install.sh` (see **Building the installer** below) and handed it to you. To install:

```sh
bash omp-install.sh
```

It will:

1. Install the `omp` binary to `~/.local/bin` (or `$PI_INSTALL_DIR` if you set it) and confirm it starts.
2. Ask for your model server's **URL**, **API key**, and one or more **model names** — then immediately test the connection and let you fix a typo before writing anything.
3. Write `~/.omp/agent/models.yml` and add `~/.local/bin` to your `PATH` if it isn't already there.

Then just run:

```sh
omp
```

Re-running the installer later is safe — if `~/.omp/agent/models.yml` already exists, it's left untouched. To redo setup (new server, new key, more models), delete that file first and re-run the installer, or hand-edit the YAML directly (see [Configuring models](#configuring-models) below).

> Currently supports **macOS on Apple Silicon (darwin-arm64)** only.

### Building the installer (once, per release)

Requires the full dev toolchain (Bun + Rust):

```sh
bun setup                                   # installs workspaces + builds the native addon
bun run --cwd packages/coding-agent build   # compiles the omp binary
bash scripts/build-installer.sh             # bundles it into one self-extracting file
```

This produces `packages/coding-agent/dist/omp-install.sh` — a single file with the compiled binary embedded (base64), so it needs no internet access and no internal artifact server to run on a target machine. Copy that one file to whoever needs `omp` and have them run it as shown above.

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

`models` is a list — add as many entries as your server exposes; every one becomes its own selectable model. Run `omp models custom` to verify discovery, then open `/model` in a session (or `omp setup`) to assign one to a role. To preconfigure the default without the picker, add to `~/.omp/agent/config.yml`:

```yaml
modelRoles:
  default: custom/your-model-id
```

Roles route work by intent: `default` for normal turns, `smol` for cheap subagent fan-out, `slow` for deep reasoning, `plan` for plan mode, `commit` for changelogs, plus `vision`, `designer`, `task`, `advisor`, and `tiny`. Cycle through configured models for the active role with `Ctrl+P`, or swap mid-session with `/model`.

## Self-learning

The agent builds up project- and preference-specific memory over time, entirely on-disk, using [mnemopi](docs/memory.md):

- **Durable facts and corrections.** When the agent learns something worth keeping — a project convention, a non-obvious fix, or a mistake and the correction that actually worked — it records it with the `learn` tool so it doesn't repeat the same mistake in a later session.
- **Reusable procedures.** Repeatable multi-step workflows get codified as managed skills (`manage_skill`), which resurface automatically in future sessions like any other skill.
- **Polyphonic recall.** Retrieval fuses four signals — vector similarity, an entity/fact graph, extracted structured facts, and recency — via reciprocal rank fusion, so relevant memories surface even when the query doesn't share exact wording with what was stored. Recency itself is weighted per memory type, so a durable lesson persists in ranking far longer than a one-off conversational aside.
- **Automatic, not manual.** Recall runs at the start of a session and again around context compaction; retention happens periodically as the conversation progresses. No slash command required for the common case.

All of this is local SQLite under `~/.omp/agent/memories/` (or your project's `.omp/`) — nothing is sent anywhere to make it work.

## Local code graph

Instead of shelling out to an external indexer, `omp` ships a lightweight, in-process code graph (`packages/coding-agent/src/utils/local-code-graph.ts`) built on the same native tree-sitter engine used by `ast_grep`:

- Covers TypeScript/JavaScript/TSX and Python function/class definitions and call sites, plus the native reuse construct for a few non-code formats: YAML anchors/aliases, CSS custom properties, HTML id/href/for/aria references, and Jinja macros.
- Builds lazily on first use per project (a one-time scan, shown as a startup progress overlay), stored at `.omp/codegraph.db`.
- Ask "who calls this," "what does this depend on," or "what breaks if I change this" and the agent queries the graph instead of grepping for text.

See [docs/tools/codegraph.md](docs/tools/codegraph.md) for the full op reference and honest limitations (name/AST-based, not a full compiler).

## Subagents

Large tasks get automatically decomposed and fanned out to subagents rather than run as one long linear turn — `task.eager` defaults to "preferred." Subagents get a filtered, purpose-scoped toolset and their own context budget, then report back a summary. See [docs/task-agent-discovery.md](docs/task-agent-discovery.md).

## What's still in the box

The provider layer and remote-facing features were cut; the actual coding-agent surface wasn't:

- **Editing** — line-anchored and hash-anchored edits, AST-aware structural edits (`ast_edit`, `ast_grep`), conflict-aware writes, checkpoints (undo across a whole turn).
- **Shell** — persistent interactive bash sessions, PTY support, timeout/output handling tuned for long-running commands.
- **LSP & DAP** — real language-server operations (go-to-definition, references, diagnostics, rename, …) and a real debugger, not text heuristics.
- **Git & GitHub** — commit/PR/review workflows, `gh` wired in as a first-class tool, conflict resolution.
- **Review** — structured code review with prioritized, verdict-bearing findings.
- **Security scanning**, **PDF/SQLite/archive reading**, **image inspection**, **browser automation**, **computer use**, **plan mode**, **vibe mode** (director + persistent worker sessions).
- **Extensibility** — user-authored skills, MCP servers, hooks, custom slash commands, extensions.

Every setting is documented in-app (`/settings`) and in [docs/settings.md](docs/settings.md); the full architecture reference lives under [docs/](docs/).

## Development

```sh
bun setup   # installs workspaces + builds the native Rust/N-API addon
bun dev     # runs the source CLI
```

Re-run `bun run build:native` after changing Rust crates or `packages/natives`. For architecture and contribution notes, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md) and [docs/](docs/).

## License

MIT — see [LICENSE](LICENSE).
