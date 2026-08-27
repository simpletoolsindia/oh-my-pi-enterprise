# codegraph

> Lightweight, fully local code graph (symbols/reuse-constructs + reference edges across TS/JS/TSX, Python, YAML, CSS, HTML, and Jinja) as an alternative to grep/glob for structural questions.

## Source
- Entry: `packages/coding-agent/src/tools/codegraph.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/codegraph.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/local-code-graph.ts` — the indexer: builds and queries the SQLite graph.
  - `@oh-my-pi/pi-natives`'s `astGrep()` (native tree-sitter, `crates/pi-natives/src/ast.rs`) — the same engine backing the `ast_grep` tool; does the gitignore-aware directory scan and pattern matching.
  - `bun:sqlite` — the local index store (same binding already used by `mnemopi`); no new dependency.
  - `packages/coding-agent/src/tools/builtin-names.ts` — registers `"codegraph"`.
  - `packages/coding-agent/src/config/settings-schema.ts` — `codegraph.enabled` setting.
  - `packages/coding-agent/src/modes/components/codegraph-scan-overlay.ts` — the first-run blocking startup scan overlay (see Notes).

This is entirely in-process TypeScript + the native binding already bundled with `omp` — no external binary, no separate install step, no network calls.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"explore" \| "query" \| "callers" \| "callees" \| "impact" \| "status"` | Yes | Which operation to run. |
| `target` | `string` | For all ops except `status` | `explore`/`callers`/`callees`/`impact`: an exact symbol name. `query`: a substring to fuzzy-search. |
| `limit` | `number` | No | Max results (`query`, `callers`, `callees`; default 20). |
| `depth` | `number` | No | Traversal depth (`impact` only; default 2). |

## Outputs
- Single-shot tool result; `content` is one plain-text block, formatted for direct model consumption (not raw JSON).
- `explore` additionally reads and inlines the matched symbol's verbatim source (line-numbered) directly from disk.
- `details` is always `{}`.

## Flow
1. `CodegraphTool.createIf(session)` returns `null` only if `codegraph.enabled` is `false` — no binary-presence gate, since there's no external binary.
2. `execute()` checks `isIndexed(cwd)` (does `<cwd>/.omp/codegraph.db` exist?). If not, it emits one `onUpdate` progress notice and calls `buildIndex(cwd)` inline before answering the query.
3. `buildIndex()` (`utils/local-code-graph.ts`) runs one scanner per language/format, each producing a common `{ name, kind?, file, startLine, endLine }` definition list and `{ name, file, line }` reference list, then merges all of them before the shared DB-write step:
   - **TypeScript/JavaScript/TSX**: one `astGrep()` call with a fixed set of definition patterns (function declarations, class declarations, arrow/function-expression consts, bare `name(...) { ... }` for class methods — each with `export`/`export default`/`async` variants, and both with and without a TypeScript return-type annotation, since `: $RET` sits between the parameter list and body as a distinct AST shape and a pattern without that slot silently fails to match any typed function). A second `astGrep()` call for call expressions (`$NAME(...)` and `$OBJ.$NAME(...)`). `kind` is classified from each match's leading tokens (no native "kind" tag exists).
   - **Python**: `def`/`async def` (with/without `-> $RET`) and `class` (with/without base classes) as definitions; `$NAME(...)`/`$OBJ.$NAME(...)` as references — same shape as TS/JS.
   - **YAML**: bare `&$NAME` (anchor) as a definition, bare `*$NAME` (alias) as a reference — these single-token patterns match directly, no wrapping needed.
   - **CSS**: a single generic `$PROP: $VALUE;` declaration pattern covers both directions — matches where `PROP` starts with `--` are custom-property definitions; every `var(--x)` occurrence inside any matched `VALUE` (extracted by regex, since `var(--$NAME)` doesn't match as a standalone ast-grep pattern) is a reference. Only `.css` files are scanned (not SCSS/LESS).
   - **HTML**: `<$TAG id="$NAME" $$$REST>` (and the self-closing form) as definitions; `<$TAG href="$HREF" ...>` filtered to `HREF` starting with `#` (fragment links), `<label for="$NAME" ...>`, and `<$TAG aria-labelledby="$NAME" ...>` as references. Bare attribute patterns like `id="$NAME"` don't match standalone in the HTML grammar — they only match as part of a full element pattern, hence the `<$TAG ...>` wrapping and the `$$$REST` slot to still match elements carrying other attributes.
   - **Jinja**: no bundled tree-sitter grammar exists for it, so this pass is plain regex over file text instead of `astGrep()` — `{% macro name(...) %}` (up to the next `{% endmacro %}`) as definitions, bare `name(` occurrences elsewhere in the file that match a known macro name as references (a macro's own declaration line is excluded so it doesn't count as calling itself). Scanned across `.html`, `.jinja`, `.jinja2`, `.j2` files (Jinja is most commonly embedded in `.html` templates) via a small hand-rolled gitignore-agnostic directory walk (`listFiles()` — the only scanner not using `astGrep()`'s own walk, since regex scanning needs raw file text rather than pattern matches).
   - Every reference is attributed to the innermost definition whose line range contains it (a plain interval check — no extra native work), or left unattributed ("module top-level" / no containing element) if none contains it. Definitions found by more than one pattern variant matching the same AST node (e.g. a typed and untyped pattern both matching) are deduped by `(file, startLine, endLine, name)` before insertion.
   - All merged, deduped results are inserted into a fresh SQLite DB at `<cwd>/.omp/codegraph.db` (three tables: `symbols`, `calls`, `meta`) inside transactions. References are only kept if their name matches something actually found in the definitions pass — call/reference sites vastly outnumber real definitions (every `.map()`, `.push()`, external-library call, etc. would otherwise bloat the table and pollute `callers`/`callees` results with noise nothing here can resolve anyway).
4. Query ops (`query`/`callers`/`callees`/`impact`/`status`) are plain indexed SQL lookups against that DB, generic across every language — they don't know or care which scanner produced a given row. `impact` does a simple BFS over `callers` transitively up to `depth` hops.

## Side Effects
- Filesystem
  - Creates `<cwd>/.omp/codegraph.db` on first use (or on the next call if the file was deleted — there is no separate `sync`/rebuild op yet, so forcing a rebuild means deleting the file).
  - `explore` reads the matched symbol's source file directly.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - None.
- Network
  - None — everything is in-process and local.
- Background work / cancellation
  - The initial `buildIndex()` call honors the tool's `AbortSignal` via `astGrep()`'s own native cancellation.

## Limits & Caps
- Each language's definition scan requests up to 200,000 matches (`DEFINITION_SCAN_LIMIT`); reference/call scans request up to 2,000,000 (`REFERENCE_SCAN_LIMIT` — call expressions vastly outnumber definitions; this repo alone has ~726k in TS/JS, and the limit must stay above the real total or results silently truncate rather than erroring). `AstFindResult.limitReached` is not currently surfaced to the model if a truly enormous repo still exceeds this.
- `query`/`callers`/`callees` default to 20 results, `impact` to 50, all overridable via `limit`.
- No incremental sync: the index is built once and never automatically refreshed as files change. Stale results are possible after large structural changes until the DB is deleted and rebuilt.
- The Jinja pass's directory walk is a small hand-rolled recursive `readdirSync` (skipping `node_modules` and dotfiles) rather than a real `.gitignore` parser — unlike every other language's scan, which rides `astGrep()`'s own gitignore-aware native walk.

## Errors
- `ToolError` when `target` is missing for an op that requires it.
- A missing/unreadable source file during `explore`'s snippet read degrades to `(source unavailable)` rather than failing the whole call.

## Notes
- Language/format scope: TypeScript, JavaScript, TSX, Python, YAML, CSS, HTML, and Jinja. Not Rust, Go, or any other language present in a mixed-language repo — not a re-architecture blocker to add more later, since each scanner is an isolated function with its own pattern set.
- "Definition" and "reference" mean different things per format, since only TS/JS/TSX and Python have real functions to call: YAML anchor/alias, CSS custom-property/`var()` usage, and HTML `id`/`href`(`#`)-`for`-`aria-labelledby` are each that format's one native reuse/cross-reference construct, not an approximation of a function call.
- This is name/AST-based, not semantic: it cannot always disambiguate two same-named symbols in different files, and it does not trace dynamic dispatch (e.g. calls through an interface/base-class method, or calls made via a computed property). Treat results as a strong lead, not ground truth.
- Jinja support is the least reliable of the set — plain regex over raw text, not AST matching, because no tree-sitter grammar for Jinja is bundled. It only recognizes `{% macro %}` definitions and plain `name(...)` call sites; `{% include %}`/`{% import %}`/`{% from %}` template-to-template dependencies are not tracked.
- `codegraph.enabled` defaults to `true`.
- On first launch in a fresh project workspace, `packages/coding-agent/src/modes/components/codegraph-scan-overlay.ts` proactively runs this same `buildIndex()` as a blocking full-screen startup overlay (progress marquee + stage text) before the interactive chat surface becomes usable, so the graph is usually already warm by the time a tool call would otherwise trigger the first-run build inline.
