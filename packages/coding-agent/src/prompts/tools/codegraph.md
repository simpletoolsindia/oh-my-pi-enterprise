Query a local, lazily-built code graph instead of grepping for structure. Prefer this over `grep`/`glob` when the question is about relationships rather than text — "who calls this," "what does this depend on," "what breaks if I change this."

Covers TypeScript/JavaScript/TSX and Python function/class definitions and call sites, plus reuse relationships native to a few non-code formats: YAML anchors (`&x`) and aliases (`*x`); CSS custom properties (`--x`) and their `var(--x)` usages; HTML `id="x"` attributes and their `href="#x"`/`for="x"`/`aria-labelledby="x"` references; and Jinja `{% macro %}` definitions and their call sites (regex-based, no bundled parser for Jinja — least reliable of the set).

This is name/AST-based, not a full compiler: it does not resolve dynamic dispatch, and two same-named symbols in different files may not always be told apart. Treat results as a strong lead, not a certainty — verify with `read`/`grep` when it matters.

Operations:
- `explore`: given an exact symbol name, returns its source plus its callers and callees in one shot.
- `query`: fuzzy-search symbols by name/substring.
- `callers`: every call site that calls a given symbol.
- `callees`: every symbol a given symbol calls.
- `impact`: multi-hop blast-radius of changing a symbol.
- `status`: index size and staleness.

The graph builds lazily on first use per project (may take a few seconds on a large repo) and does not auto-refresh — re-run after large structural changes if results look stale (no built-in `sync` op yet; deleting `.omp/codegraph.db` forces a full rebuild on the next call).
