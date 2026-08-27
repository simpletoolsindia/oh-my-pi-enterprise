import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { untilAborted } from "@oh-my-pi/pi-utils";
import codegraphDescription from "../prompts/tools/codegraph.md" with { type: "text" };
import {
	buildIndex,
	findCallees,
	findCallers,
	findImpact,
	status as graphStatus,
	isIndexed,
	querySymbols,
} from "../utils/local-code-graph";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

const codegraphSchema = type({
	op: type("'explore' | 'query' | 'callers' | 'callees' | 'impact' | 'status'").describe("codegraph operation"),
	"target?": type("string").describe("symbol name (or substring for query). Not used by status."),
	"limit?": type("number").describe("max results (query/callers/callees only)"),
	"depth?": type("number").describe("traversal depth (impact only, default 2)"),
});

export type CodegraphInput = typeof codegraphSchema.infer;

export class CodegraphTool implements AgentTool<typeof codegraphSchema> {
	readonly name = "codegraph";
	readonly approval = "read" as const;
	readonly label = "CodeGraph";
	readonly summary = "Query the local code graph (symbols, callers, callees, impact)";
	readonly description = codegraphDescription;
	readonly parameters = codegraphSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): CodegraphTool | null {
		if (session.settings.get("codegraph.enabled") === false) return null;
		return new CodegraphTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CodegraphInput,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback,
		_context?: AgentToolContext,
	): Promise<AgentToolResult> {
		return untilAborted(signal, async () => {
			const cwd = this.session.cwd;
			if (!isIndexed(cwd)) {
				onUpdate?.({
					content: [{ type: "text", text: "Building code graph for this project (first run only)…" }],
					details: {},
				});
				await buildIndex(cwd, undefined, signal);
			}

			const text = runOp(cwd, params);
			return { content: [{ type: "text", text }], details: {} };
		});
	}
}

function requireTarget(params: CodegraphInput): string {
	const target = params.target?.trim();
	if (!target) throw new ToolError(`${params.op} requires \`target\` (a symbol name).`);
	return target;
}

function readSnippet(cwd: string, file: string, startLine: number, endLine: number): string {
	try {
		const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
		const lines = fs.readFileSync(absolute, "utf8").split("\n");
		return lines
			.slice(Math.max(0, startLine - 1), endLine)
			.map((line, i) => `${startLine + i}\t${line}`)
			.join("\n");
	} catch {
		return "(source unavailable)";
	}
}

function runOp(cwd: string, params: CodegraphInput): string {
	switch (params.op) {
		case "status": {
			const s = graphStatus(cwd);
			if (!s.indexed) return "Not indexed yet.";
			const when = s.lastIndexedAt ? new Date(s.lastIndexedAt).toISOString() : "unknown";
			return `Files: ${s.fileCount}\nSymbols: ${s.symbolCount}\nCalls: ${s.callCount}\nLast indexed: ${when}`;
		}
		case "query": {
			const target = requireTarget(params);
			const results = querySymbols(cwd, target, params.limit ?? 20);
			if (results.length === 0) return `No symbols matching "${target}".`;
			return [
				`Symbols matching "${target}" (${results.length}):`,
				"",
				...results.map(r => `${r.kind}\t${r.name}\n  ${r.file}:${r.startLine}`),
			].join("\n");
		}
		case "callers": {
			const target = requireTarget(params);
			const results = findCallers(cwd, target, params.limit ?? 20);
			if (results.length === 0) return `No callers found for "${target}".`;
			return [
				`Callers of "${target}" (${results.length}):`,
				"",
				...results.map(
					r => `${r.name ? `${r.kind ?? "?"}\t${r.name}` : "(module top-level)"}\n  ${r.file}:${r.line}`,
				),
			].join("\n");
		}
		case "callees": {
			const target = requireTarget(params);
			const results = findCallees(cwd, target, params.limit ?? 20);
			if (results.length === 0) return `No callees found for "${target}".`;
			return [
				`Callees of "${target}" (${results.length}):`,
				"",
				...results.map(r => `${r.calleeName}\n  ${r.file}:${r.line}`),
			].join("\n");
		}
		case "impact": {
			const target = requireTarget(params);
			const results = findImpact(cwd, target, params.depth ?? 2, params.limit ?? 50);
			if (results.length === 0) return `Nothing depends on "${target}".`;
			return [
				`Impact of changing "${target}" — ${results.length} affected call sites:`,
				"",
				...results.map(r => `hop ${r.hop}: ${r.name ?? "(module top-level)"}\n  ${r.file}:${r.line}`),
			].join("\n");
		}
		case "explore": {
			const target = requireTarget(params);
			const defs = querySymbols(cwd, target, 5).filter(r => r.name === target);
			if (defs.length === 0) return `No symbol named "${target}" found. Try \`query\` for a fuzzy search.`;
			const callers = findCallers(cwd, target, 10);
			const callees = findCallees(cwd, target, 10);
			const parts: string[] = [`**Exploring "${target}"**`, ""];
			for (const def of defs) {
				parts.push(`**${def.kind} ${def.name}** — ${def.file}:${def.startLine}-${def.endLine}`);
				parts.push("```");
				parts.push(readSnippet(cwd, def.file, def.startLine, def.endLine));
				parts.push("```");
			}
			parts.push(`**Callers (${callers.length}):**`);
			parts.push(...callers.map(c => `- ${c.name ?? "(module top-level)"} — ${c.file}:${c.line}`));
			parts.push(`**Callees (${callees.length}):**`);
			parts.push(...callees.map(c => `- ${c.calleeName} — ${c.file}:${c.line}`));
			return parts.join("\n");
		}
	}
}
