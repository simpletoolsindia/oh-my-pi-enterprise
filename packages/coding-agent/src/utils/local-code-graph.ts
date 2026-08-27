/**
 * Lightweight, fully local code graph — no external binary, no new
 * dependency. Built on the native tree-sitter/ast-grep engine already
 * bundled for the `ast_grep` tool (`astGrep()`), plus a small SQLite index
 * (`bun:sqlite`, the same binding already used by mnemopi) for fast
 * callers/callees/impact lookups.
 *
 * This is name/AST-based, not a full compiler: it cannot always disambiguate
 * two same-named symbols in different files, and it does not trace dynamic
 * dispatch. It's a lightweight aid, not a semantic-analysis replacement.
 *
 * Language coverage and what "definition"/"reference" means for each:
 * - TypeScript/JavaScript/TSX: function/class/method definitions, call sites.
 * - Python: function/class definitions, call sites.
 * - YAML: anchors (`&name`) as definitions, aliases (`*name`) as references.
 * - CSS: custom properties (`--name: ...`) as definitions, `var(--name)`
 *   usages as references.
 * - HTML: `id="name"` attributes as definitions; `href="#name"`,
 *   `for="name"`, and `aria-labelledby="name"` as references.
 * - Jinja: regex-based (no bundled tree-sitter grammar for it) — `{% macro
 *   name(...) %}` as definitions, `name(...)` call sites as references.
 *   Scanned in `.html`/`.jinja`/`.jinja2`/`.j2` files.
 */
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { astGrep } from "@oh-my-pi/pi-natives";

// Call/reference sites vastly outnumber definitions (every `.map()`/`.push()`
// counts) — this repo alone has ~726k call expressions in TS/JS. Must stay
// above the real total or results silently truncate.
const DEFINITION_SCAN_LIMIT = 200_000;
const REFERENCE_SCAN_LIMIT = 2_000_000;

export type LocalCodeGraphSymbolKind =
	| "function"
	| "class"
	| "method"
	| "variable_fn"
	| "yaml_anchor"
	| "css_property"
	| "html_id"
	| "jinja_macro";

export interface LocalCodeGraphSymbol {
	id: number;
	name: string;
	kind: LocalCodeGraphSymbolKind;
	file: string;
	startLine: number;
	endLine: number;
}

export interface LocalCodeGraphCaller {
	name: string | null;
	kind: LocalCodeGraphSymbolKind | null;
	file: string;
	line: number;
}

export interface LocalCodeGraphStatus {
	indexed: boolean;
	fileCount: number;
	symbolCount: number;
	callCount: number;
	lastIndexedAt: number | undefined;
}

interface RawDefinition {
	name: string;
	kind: LocalCodeGraphSymbolKind;
	file: string;
	startLine: number;
	endLine: number;
}

interface RawReference {
	name: string;
	file: string;
	line: number;
}

export function dbPathFor(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".omp", "codegraph.db");
}

export function isIndexed(workspaceRoot: string): boolean {
	return fs.existsSync(dbPathFor(workspaceRoot));
}

function openDb(workspaceRoot: string): Database {
	const dbPath = dbPathFor(workspaceRoot);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	db.exec(`
		CREATE TABLE IF NOT EXISTS symbols (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			file TEXT NOT NULL,
			start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
		CREATE INDEX IF NOT EXISTS idx_symbols_file_lines ON symbols(file, start_line, end_line);

		CREATE TABLE IF NOT EXISTS calls (
			id INTEGER PRIMARY KEY,
			caller_symbol_id INTEGER,
			callee_name TEXT NOT NULL,
			file TEXT NOT NULL,
			line INTEGER NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee_name);
		CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller_symbol_id);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT
		);
	`);
	return db;
}

// ── TypeScript / JavaScript / TSX ───────────────────────────────────────────

/** `{ $$$BODY }` vs `: $RET { $$$BODY }` — a TS return-type annotation sits
 * between the parameter list and the body and is a distinct AST shape, so a
 * pattern without a `$RET` slot silently fails to match any typed function
 * (i.e. most real-world exported TS functions). Both forms are needed. */
function tsBodyForms(): string[] {
	return ["{ $$$BODY }", ": $RET { $$$BODY }"];
}

function tsFunctionDeclarationPatterns(): string[] {
	const prefixes = [
		"function",
		"export function",
		"export default function",
		"async function",
		"export async function",
		"export default async function",
	];
	return prefixes.flatMap(prefix => tsBodyForms().map(body => `${prefix} $NAME($$$ARGS) ${body}`));
}

function tsClassPatterns(): string[] {
	return ["class $NAME { $$$BODY }", "export class $NAME { $$$BODY }", "export default class $NAME { $$$BODY }"];
}

function tsVariableFunctionPatterns(): string[] {
	const constPrefixes = ["const", "export const"];
	const patterns: string[] = [];
	for (const prefix of constPrefixes) {
		for (const arrow of ["=> $$$BODY", ": $RET => $$$BODY"]) {
			patterns.push(`${prefix} $NAME = ($$$ARGS) ${arrow}`);
			patterns.push(`${prefix} $NAME = async ($$$ARGS) ${arrow}`);
		}
		for (const body of tsBodyForms()) {
			patterns.push(`${prefix} $NAME = function ($$$ARGS) ${body}`);
			patterns.push(`${prefix} $NAME = async function ($$$ARGS) ${body}`);
		}
	}
	return patterns;
}

function tsMethodPatterns(): string[] {
	const prefixes = ["", "async "];
	return prefixes.flatMap(prefix => tsBodyForms().map(body => `${prefix}$NAME($$$ARGS) ${body}`));
}

function classifyTsKind(text: string): LocalCodeGraphSymbolKind {
	const trimmed = text.trimStart();
	if (/^(export\s+(default\s+)?)?class\b/.test(trimmed)) return "class";
	if (/^(export\s+(default\s+)?)?(async\s+)?function\b/.test(trimmed)) return "function";
	if (/^export\s+const\b|^const\b/.test(trimmed)) return "variable_fn";
	return "method";
}

async function scanTypeScript(
	workspaceRoot: string,
	signal: AbortSignal | undefined,
): Promise<{ definitions: RawDefinition[]; references: RawReference[]; fileCount: number }> {
	const glob = "**/*.{ts,tsx,js,jsx}";
	const definitionPatterns = [
		...tsFunctionDeclarationPatterns(),
		...tsClassPatterns(),
		...tsVariableFunctionPatterns(),
		...tsMethodPatterns(),
	];
	const defResult = await astGrep({
		patterns: definitionPatterns,
		path: workspaceRoot,
		glob,
		limit: DEFINITION_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const refResult = await astGrep({
		patterns: ["$NAME($$$ARGS)", "$OBJ.$NAME($$$ARGS)"],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const definitions = defResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		if (!name) return [];
		return [{ name, kind: classifyTsKind(m.text), file: m.path, startLine: m.startLine, endLine: m.endLine }];
	});
	const references = refResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		return name ? [{ name, file: m.path, line: m.startLine }] : [];
	});
	const fileCount = new Set([...defResult.matches.map(m => m.path), ...refResult.matches.map(m => m.path)]).size;
	return { definitions, references, fileCount };
}

// ── Python ───────────────────────────────────────────────────────────────

async function scanPython(
	workspaceRoot: string,
	signal: AbortSignal | undefined,
): Promise<{ definitions: RawDefinition[]; references: RawReference[]; fileCount: number }> {
	const glob = "**/*.py";
	const definitionPatterns = [
		"def $NAME($$$ARGS): $$$BODY",
		"def $NAME($$$ARGS) -> $RET: $$$BODY",
		"async def $NAME($$$ARGS): $$$BODY",
		"async def $NAME($$$ARGS) -> $RET: $$$BODY",
		"class $NAME: $$$BODY",
		"class $NAME($$$BASES): $$$BODY",
	];
	const defResult = await astGrep({
		patterns: definitionPatterns,
		path: workspaceRoot,
		glob,
		limit: DEFINITION_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const refResult = await astGrep({
		patterns: ["$NAME($$$ARGS)", "$OBJ.$NAME($$$ARGS)"],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const definitions = defResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		if (!name) return [];
		const kind: LocalCodeGraphSymbolKind = m.text.trimStart().startsWith("class") ? "class" : "function";
		return [{ name, kind, file: m.path, startLine: m.startLine, endLine: m.endLine }];
	});
	const references = refResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		return name ? [{ name, file: m.path, line: m.startLine }] : [];
	});
	const fileCount = new Set([...defResult.matches.map(m => m.path), ...refResult.matches.map(m => m.path)]).size;
	return { definitions, references, fileCount };
}

// ── YAML ─────────────────────────────────────────────────────────────────

async function scanYaml(
	workspaceRoot: string,
	signal: AbortSignal | undefined,
): Promise<{ definitions: RawDefinition[]; references: RawReference[]; fileCount: number }> {
	const glob = "**/*.{yml,yaml}";
	const defResult = await astGrep({
		patterns: ["&$NAME"],
		path: workspaceRoot,
		glob,
		limit: DEFINITION_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const refResult = await astGrep({
		patterns: ["*$NAME"],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const definitions = defResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		if (!name) return [];
		return [{ name, kind: "yaml_anchor" as const, file: m.path, startLine: m.startLine, endLine: m.endLine }];
	});
	const references = refResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		return name ? [{ name, file: m.path, line: m.startLine }] : [];
	});
	const fileCount = new Set([...defResult.matches.map(m => m.path), ...refResult.matches.map(m => m.path)]).size;
	return { definitions, references, fileCount };
}

// ── CSS ──────────────────────────────────────────────────────────────────

const CSS_VAR_USAGE_RE = /var\(\s*--([a-zA-Z0-9_-]+)/g;

async function scanCss(
	workspaceRoot: string,
	signal: AbortSignal | undefined,
): Promise<{ definitions: RawDefinition[]; references: RawReference[]; fileCount: number }> {
	// A single declaration pattern (`prop: value;`) covers both custom-property
	// definitions and `var(--x)` usages — ast-grep can't match the bare
	// `--$NAME` token as its own pattern (the `--` prefix isn't decomposable
	// that way in the CSS grammar), so definitions are recognized by filtering
	// PROP afterward, and usages are pulled out of VALUE by regex.
	const result = await astGrep({
		patterns: ["$PROP: $VALUE;"],
		path: workspaceRoot,
		glob: "**/*.css",
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const definitions: RawDefinition[] = [];
	const references: RawReference[] = [];
	for (const m of result.matches) {
		const prop = m.metaVariables?.PROP;
		const value = m.metaVariables?.VALUE;
		if (prop?.startsWith("--")) {
			definitions.push({
				name: prop,
				kind: "css_property",
				file: m.path,
				startLine: m.startLine,
				endLine: m.endLine,
			});
		}
		if (value) {
			for (const match of value.matchAll(CSS_VAR_USAGE_RE)) {
				references.push({ name: `--${match[1]}`, file: m.path, line: m.startLine });
			}
		}
	}
	const fileCount = new Set(result.matches.map(m => m.path)).size;
	return { definitions, references, fileCount };
}

// ── HTML ─────────────────────────────────────────────────────────────────

async function scanHtml(
	workspaceRoot: string,
	signal: AbortSignal | undefined,
): Promise<{ definitions: RawDefinition[]; references: RawReference[]; fileCount: number }> {
	const glob = "**/*.html";
	const defResult = await astGrep({
		patterns: ['<$TAG id="$NAME" $$$REST>', '<$TAG id="$NAME" $$$REST />'],
		path: workspaceRoot,
		glob,
		limit: DEFINITION_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const hrefResult = await astGrep({
		patterns: ['<$TAG href="$HREF" $$$REST>$$$BODY</$TAG>'],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const forResult = await astGrep({
		patterns: ['<label for="$NAME" $$$REST>$$$BODY</label>'],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});
	const ariaResult = await astGrep({
		patterns: ['<$TAG aria-labelledby="$NAME" $$$REST>$$$BODY</$TAG>'],
		path: workspaceRoot,
		glob,
		limit: REFERENCE_SCAN_LIMIT,
		includeMeta: true,
		signal: signal as unknown,
	});

	const definitions = defResult.matches.flatMap(m => {
		const name = m.metaVariables?.NAME;
		if (!name) return [];
		return [{ name, kind: "html_id" as const, file: m.path, startLine: m.startLine, endLine: m.endLine }];
	});
	const references: RawReference[] = [];
	for (const m of hrefResult.matches) {
		const href = m.metaVariables?.HREF;
		if (href?.startsWith("#")) references.push({ name: href.slice(1), file: m.path, line: m.startLine });
	}
	for (const m of [...forResult.matches, ...ariaResult.matches]) {
		const name = m.metaVariables?.NAME;
		if (name) references.push({ name, file: m.path, line: m.startLine });
	}
	const fileCount = new Set(
		[...defResult.matches, ...hrefResult.matches, ...forResult.matches, ...ariaResult.matches].map(m => m.path),
	).size;
	return { definitions, references, fileCount };
}

// ── Jinja (regex-based — no bundled tree-sitter grammar for it) ────────────

const JINJA_MACRO_RE = /\{%-?\s*macro\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
const JINJA_CALL_RE = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

function listFiles(root: string, dir: string, exts: Set<string>, out: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			listFiles(root, full, exts, out);
		} else if (exts.has(path.extname(entry.name).toLowerCase())) {
			out.push(path.relative(root, full));
		}
	}
}

function scanJinja(workspaceRoot: string): {
	definitions: RawDefinition[];
	references: RawReference[];
	fileCount: number;
} {
	const files: string[] = [];
	listFiles(workspaceRoot, workspaceRoot, new Set([".html", ".jinja", ".jinja2", ".j2"]), files);

	const definitions: RawDefinition[] = [];
	const macroNames = new Set<string>();
	const fileLines = new Map<string, string[]>();
	for (const file of files) {
		let text: string;
		try {
			text = fs.readFileSync(path.join(workspaceRoot, file), "utf8");
		} catch {
			continue;
		}
		if (!text.includes("{%") && !text.includes("{{")) continue; // not a Jinja file
		const lines = text.split("\n");
		fileLines.set(file, lines);
		for (const match of text.matchAll(JINJA_MACRO_RE)) {
			const name = match[1];
			const startLine = text.slice(0, match.index).split("\n").length;
			const endMarker = text.indexOf("{% endmacro %}", match.index);
			const endLine = endMarker === -1 ? startLine : text.slice(0, endMarker).split("\n").length;
			definitions.push({ name, kind: "jinja_macro", file, startLine, endLine });
			macroNames.add(name);
		}
	}

	const references: RawReference[] = [];
	for (const [file, lines] of fileLines) {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			// Skip a macro's own `{% macro name(...) %}` line so its declaration
			// isn't counted as a call to itself.
			if (/\{%-?\s*macro\s+/.test(line)) continue;
			for (const match of line.matchAll(JINJA_CALL_RE)) {
				const name = match[1];
				if (macroNames.has(name)) references.push({ name, file, line: i + 1 });
			}
		}
	}
	return { definitions, references, fileCount: fileLines.size };
}

// ── Shared build/query ──────────────────────────────────────────────────

/** Innermost (smallest-range) symbol on `file` whose line range contains `line`. */
function findContaining(byFile: Map<string, LocalCodeGraphSymbol[]>, file: string, line: number): number | null {
	const candidates = byFile.get(file);
	if (!candidates) return null;
	let best: LocalCodeGraphSymbol | undefined;
	for (const sym of candidates) {
		if (line < sym.startLine || line > sym.endLine) continue;
		if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
	}
	return best?.id ?? null;
}

export interface BuildIndexResult {
	files: number;
	symbols: number;
	calls: number;
}

export async function buildIndex(
	workspaceRoot: string,
	onProgress?: (stage: string) => void,
	signal?: AbortSignal,
): Promise<BuildIndexResult> {
	onProgress?.("Scanning TypeScript/JavaScript…");
	const ts = await scanTypeScript(workspaceRoot, signal);
	onProgress?.("Scanning Python…");
	const py = await scanPython(workspaceRoot, signal);
	onProgress?.("Scanning YAML…");
	const yaml = await scanYaml(workspaceRoot, signal);
	onProgress?.("Scanning CSS…");
	const css = await scanCss(workspaceRoot, signal);
	onProgress?.("Scanning HTML…");
	const html = await scanHtml(workspaceRoot, signal);
	onProgress?.("Scanning Jinja templates…");
	const jinja = scanJinja(workspaceRoot);

	const allDefinitions = [
		...ts.definitions,
		...py.definitions,
		...yaml.definitions,
		...css.definitions,
		...html.definitions,
		...jinja.definitions,
	];
	const allReferences = [
		...ts.references,
		...py.references,
		...yaml.references,
		...css.references,
		...html.references,
		...jinja.references,
	];
	const totalFiles = ts.fileCount + py.fileCount + yaml.fileCount + css.fileCount + html.fileCount + jinja.fileCount;

	onProgress?.("Building index…");
	const db = openDb(workspaceRoot);
	try {
		db.exec("DELETE FROM symbols; DELETE FROM calls;");

		// Multiple pattern variants (return-type vs. not, async vs. not, etc.)
		// can match the exact same AST node — dedupe by identity (name + exact
		// span) before inserting, or a definition can show up multiple times.
		const seenDefs = new Set<string>();
		const dedupedDefs: RawDefinition[] = [];
		for (const def of allDefinitions) {
			const key = `${def.file}:${def.startLine}:${def.endLine}:${def.name}`;
			if (seenDefs.has(key)) continue;
			seenDefs.add(key);
			dedupedDefs.push(def);
		}

		const symbols: LocalCodeGraphSymbol[] = [];
		const insertSymbol = db.prepare(
			"INSERT INTO symbols (name, kind, file, start_line, end_line) VALUES (?, ?, ?, ?, ?)",
		);
		const insertSymbols = db.transaction((defs: RawDefinition[]) => {
			for (const def of defs) {
				const result = insertSymbol.run(def.name, def.kind, def.file, def.startLine, def.endLine);
				symbols.push({ id: Number(result.lastInsertRowid), ...def });
			}
		});
		insertSymbols(dedupedDefs);

		const byFile = new Map<string, LocalCodeGraphSymbol[]>();
		for (const sym of symbols) {
			const list = byFile.get(sym.file);
			if (list) list.push(sym);
			else byFile.set(sym.file, [sym]);
		}

		// References vastly outnumber our own definitions (every `.map()`,
		// `.push()`, external-library call counts). We can only ever resolve a
		// reference back to a symbol WE indexed, so drop everything else here —
		// this is what keeps the table small and "callers of X" queries correct
		// (the raw scans themselves must still see every site to find the ones
		// that matter, hence the much higher REFERENCE_SCAN_LIMIT above).
		const knownNames = new Set(symbols.map(s => s.name));
		const insertCall = db.prepare(
			"INSERT INTO calls (caller_symbol_id, callee_name, file, line) VALUES (?, ?, ?, ?)",
		);
		let callCount = 0;
		const insertCalls = db.transaction((refs: RawReference[]) => {
			for (const ref of refs) {
				if (!knownNames.has(ref.name)) continue;
				const callerId = findContaining(byFile, ref.file, ref.line);
				insertCall.run(callerId, ref.name, ref.file, ref.line);
				callCount++;
			}
		});
		insertCalls(allReferences);

		const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
		setMeta.run("last_indexed_at", String(Date.now()));
		setMeta.run("file_count", String(totalFiles));
		setMeta.run("symbol_count", String(symbols.length));
		setMeta.run("call_count", String(callCount));

		return { files: totalFiles, symbols: symbols.length, calls: callCount };
	} finally {
		db.close();
	}
}

export function status(workspaceRoot: string): LocalCodeGraphStatus {
	if (!isIndexed(workspaceRoot)) {
		return { indexed: false, fileCount: 0, symbolCount: 0, callCount: 0, lastIndexedAt: undefined };
	}
	const db = openDb(workspaceRoot);
	try {
		const rows = db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[];
		const meta = Object.fromEntries(rows.map(r => [r.key, r.value]));
		return {
			indexed: true,
			fileCount: Number(meta.file_count ?? 0),
			symbolCount: Number(meta.symbol_count ?? 0),
			callCount: Number(meta.call_count ?? 0),
			lastIndexedAt: meta.last_indexed_at ? Number(meta.last_indexed_at) : undefined,
		};
	} finally {
		db.close();
	}
}

export function querySymbols(workspaceRoot: string, name: string, limit = 20): LocalCodeGraphSymbol[] {
	const db = openDb(workspaceRoot);
	try {
		const rows = db
			.query(
				"SELECT id, name, kind, file, start_line as startLine, end_line as endLine FROM symbols WHERE name LIKE ? ORDER BY name LIMIT ?",
			)
			.all(`%${name}%`, limit) as LocalCodeGraphSymbol[];
		return rows;
	} finally {
		db.close();
	}
}

export function findCallers(workspaceRoot: string, name: string, limit = 20): LocalCodeGraphCaller[] {
	const db = openDb(workspaceRoot);
	try {
		const rows = db
			.query(
				`SELECT s.name as name, s.kind as kind, c.file as file, c.line as line
				 FROM calls c LEFT JOIN symbols s ON s.id = c.caller_symbol_id
				 WHERE c.callee_name = ? LIMIT ?`,
			)
			.all(name, limit) as LocalCodeGraphCaller[];
		return rows;
	} finally {
		db.close();
	}
}

export function findCallees(
	workspaceRoot: string,
	name: string,
	limit = 20,
): { calleeName: string; file: string; line: number }[] {
	const db = openDb(workspaceRoot);
	try {
		const targets = db.query("SELECT id FROM symbols WHERE name = ?").all(name) as { id: number }[];
		if (targets.length === 0) return [];
		const placeholders = targets.map(() => "?").join(",");
		const rows = db
			.query(
				`SELECT DISTINCT callee_name as calleeName, file, line FROM calls WHERE caller_symbol_id IN (${placeholders}) LIMIT ?`,
			)
			.all(...targets.map(t => t.id), limit) as { calleeName: string; file: string; line: number }[];
		return rows;
	} finally {
		db.close();
	}
}

export function findImpact(
	workspaceRoot: string,
	name: string,
	depth = 2,
	limit = 50,
): { name: string | null; file: string; line: number; hop: number }[] {
	const db = openDb(workspaceRoot);
	try {
		const results: { name: string | null; file: string; line: number; hop: number }[] = [];
		const seen = new Set<string>();
		let frontier = [name];
		for (let hop = 1; hop <= depth && results.length < limit; hop++) {
			const next: string[] = [];
			for (const target of frontier) {
				const rows = db
					.query(
						`SELECT s.name as name, c.file as file, c.line as line
						 FROM calls c LEFT JOIN symbols s ON s.id = c.caller_symbol_id
						 WHERE c.callee_name = ?`,
					)
					.all(target) as { name: string | null; file: string; line: number }[];
				for (const row of rows) {
					const key = `${row.file}:${row.line}`;
					if (seen.has(key)) continue;
					seen.add(key);
					results.push({ ...row, hop });
					if (row.name) next.push(row.name);
					if (results.length >= limit) break;
				}
				if (results.length >= limit) break;
			}
			frontier = next;
			if (frontier.length === 0) break;
		}
		return results;
	} finally {
		db.close();
	}
}
