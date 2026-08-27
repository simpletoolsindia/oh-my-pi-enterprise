/**
 * `omp perf report` — local performance measurement.
 *
 * Measures key latencies across agent subsystems and reports them as a
 * human-readable summary (or JSON). No network calls are made; the report
 * quantifies local overhead only.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDbPath, getAgentDir } from "@oh-my-pi/pi-utils";

export interface PerfCommandArgs {
	json: boolean;
}

interface PerfMetric {
	name: string;
	durationMs: number;
	note?: string;
}

async function measureStartupOverhead(): Promise<PerfMetric> {
	const start = performance.now();
	// Measure the cost of loading the settings module — a proxy for startup
	// config resolution, since it reads env, dirs, and the config cascade.
	const { Settings } = await import("../config/settings");
	void Settings; // ensure the import is not tree-shaken
	const durationMs = performance.now() - start;
	return { name: "settings_module_load", durationMs, note: "Time to load and resolve settings module" };
}

async function measureSqliteOpen(): Promise<PerfMetric> {
	const agentDir = getAgentDir();
	const dbPath = getAgentDbPath(agentDir);
	const start = performance.now();
	try {
		const { Database } = await import("bun:sqlite");
		const db = new Database(dbPath, { readonly: true });
		db.exec("SELECT 1");
		db.close();
	} catch {
		// DB may not exist yet; that is fine — we report the attempt latency.
	}
	const durationMs = performance.now() - start;
	return { name: "sqlite_open", durationMs, note: "Time to open and ping the agent state database" };
}

async function measureNativeAddonLoad(): Promise<PerfMetric> {
	const start = performance.now();
	try {
		const natives = await import("@oh-my-pi/pi-natives");
		// Force initialization by calling a trivial function.
		natives.visibleWidth("hello", 8);
	} catch {
		// Addon may not be built; report the latency of the attempt.
	}
	const durationMs = performance.now() - start;
	return {
		name: "native_addon_load",
		durationMs,
		note: "Time to load the Rust native addon and invoke a trivial call",
	};
}

async function measureGrepLatency(): Promise<PerfMetric> {
	const start = performance.now();
	try {
		const { grep } = await import("@oh-my-pi/pi-natives");
		// Search for a common token in the current directory with a 1-file limit
		// to measure directory traversal + regex compile overhead.
		await grep({ path: process.cwd(), pattern: "import", maxCount: 1 });
	} catch {
		// May fail if cwd is empty or addon is unavailable.
	}
	const durationMs = performance.now() - start;
	return { name: "grep_single_match", durationMs, note: "Time for one grep match in cwd (traversal + regex)" };
}

async function measureGlobLatency(): Promise<PerfMetric> {
	const start = performance.now();
	try {
		const { glob } = await import("@oh-my-pi/pi-natives");
		await glob({ path: process.cwd(), pattern: "**/*.ts", maxResults: 10 });
	} catch {
		// May fail if addon is unavailable.
	}
	const durationMs = performance.now() - start;
	return { name: "glob_10_results", durationMs, note: "Time to glob 10 TypeScript files from cwd" };
}

async function measureMnemopiDbSize(): Promise<PerfMetric> {
	const agentDir = getAgentDir();
	const mnemopiDir = path.join(agentDir, "memories", "mnemopi");
	let totalBytes = 0;
	try {
		const entries = await fs.readdir(mnemopiDir);
		for (const entry of entries) {
			if (entry.endsWith(".db") || entry.endsWith(".db-wal") || entry.endsWith(".db-shm")) {
				const stat = await fs.stat(path.join(mnemopiDir, entry));
				totalBytes += stat.size;
			}
		}
	} catch {
		// Dir may not exist.
	}
	return {
		name: "mnemopi_db_size_bytes",
		durationMs: totalBytes,
		note: `Total Mnemopi SQLite storage: ${(totalBytes / 1024).toFixed(1)} KiB`,
	};
}

async function measureCodegraphSize(): Promise<PerfMetric> {
	const dbPath = path.join(process.cwd(), ".omp", "codegraph.db");
	let sizeBytes = 0;
	try {
		const stat = await fs.stat(dbPath);
		sizeBytes = stat.size;
	} catch {
		// No codegraph built yet.
	}
	return {
		name: "codegraph_db_size_bytes",
		durationMs: sizeBytes,
		note: sizeBytes > 0 ? `Codegraph index: ${(sizeBytes / 1024).toFixed(1)} KiB` : "No codegraph.db found in cwd",
	};
}

export async function runPerfReport(args: PerfCommandArgs): Promise<void> {
	const overallStart = performance.now();

	const metrics: PerfMetric[] = [];

	// Sequential measurements to avoid interference.
	metrics.push(await measureStartupOverhead());
	metrics.push(await measureSqliteOpen());
	metrics.push(await measureNativeAddonLoad());
	metrics.push(await measureGrepLatency());
	metrics.push(await measureGlobLatency());
	metrics.push(await measureMnemopiDbSize());
	metrics.push(await measureCodegraphSize());

	const totalMs = performance.now() - overallStart;
	metrics.push({ name: "perf_report_total", durationMs: totalMs, note: "Total time to run all measurements" });

	if (args.json) {
		const output = {
			timestamp: new Date().toISOString(),
			cwd: process.cwd(),
			metrics: metrics.map(m => ({
				name: m.name,
				value: Number(m.durationMs.toFixed(2)),
				note: m.note,
			})),
		};
		process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
		return;
	}

	// Human-readable output.
	process.stdout.write("\n=== OMP Performance Report ===\n\n");
	process.stdout.write(`cwd: ${process.cwd()}\n`);
	process.stdout.write(`timestamp: ${new Date().toISOString()}\n\n`);

	const nameWidth = Math.max(...metrics.map(m => m.name.length));
	for (const metric of metrics) {
		const name = metric.name.padEnd(nameWidth);
		const isSizeMetric = metric.name.endsWith("_bytes");
		const value = isSizeMetric
			? `${(metric.durationMs / 1024).toFixed(1)} KiB`.padStart(12)
			: `${metric.durationMs.toFixed(1)} ms`.padStart(12);
		const note = metric.note ? `  # ${metric.note}` : "";
		process.stdout.write(`  ${name}  ${value}${note}\n`);
	}
	process.stdout.write("\n");
}
