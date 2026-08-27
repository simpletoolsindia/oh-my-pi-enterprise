/**
 * `/provider` slash command — manage custom LLM providers from the TUI.
 *
 * Subcommands:
 *   /provider              — list configured providers and models
 *   /provider add          — add a new provider (opens editor with template)
 *   /provider edit         — open models.yml in your $EDITOR
 *   /provider test         — test the connection to all configured providers
 *   /provider reload       — reload models after manual edits
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

function getModelsPath(): string {
	return path.join(getAgentDir(), "models.yml");
}

async function listProviders(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const modelsPath = getModelsPath();
	let content: string;
	try {
		content = await Bun.file(modelsPath).text();
	} catch {
		runtime.output("No models.yml found. Run /provider add to create one.");
		return { consumed: true };
	}

	// Parse providers from the YAML (simple extraction — avoid heavy deps)
	const providerLines: string[] = [];
	let inProviders = false;
	let currentProvider = "";
	for (const line of content.split("\n")) {
		if (/^providers:/.test(line)) {
			inProviders = true;
			continue;
		}
		if (inProviders && /^\s{2}\S/.test(line) && line.includes(":")) {
			currentProvider = line.trim().replace(/:.*$/, "");
			providerLines.push(`\n  Provider: ${currentProvider}`);
		}
		if (inProviders && /baseUrl/.test(line)) {
			providerLines.push(`    URL: ${line.replace(/.*baseUrl:\s*/, "").replace(/["']/g, "")}`);
		}
		if (inProviders && /^\s{6,8}-\s*id:/.test(line)) {
			const modelId = line
				.replace(/.*id:\s*/, "")
				.replace(/["']/g, "")
				.trim();
			providerLines.push(`    Model: ${modelId}`);
		}
	}

	if (providerLines.length === 0) {
		runtime.output("No providers configured. Run /provider add to set one up.");
	} else {
		runtime.output(
			`Configured providers (${modelsPath}):\n${providerLines.join("\n")}\n\nSubcommands: /provider add | edit | test | reload`,
		);
	}
	return { consumed: true };
}

async function addProvider(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const modelsPath = getModelsPath();
	let exists = false;
	try {
		await fs.access(modelsPath);
		exists = true;
	} catch {}

	if (exists) {
		runtime.output(
			`models.yml already exists at ${modelsPath}\n` +
				`Use /provider edit to modify it, or delete it first.\n` +
				`Current config:\n`,
		);
		return listProviders(runtime);
	}

	// Write the template
	await fs.mkdir(path.dirname(modelsPath), { recursive: true });
	const defaultConfig = `providers:
  custom:
    baseUrl: "http://localhost:11434/v1"
    apiKey: "ollama"
    api: openai-completions
    models:
      - id: gemma4
        name: Gemma 4
        contextWindow: 128000
        maxTokens: 8192
`;
	await Bun.write(modelsPath, defaultConfig);
	runtime.output(
		`Created ${modelsPath} with a default Ollama configuration.\n\n` +
			`Edit it to match your server:\n` +
			`  1. Change baseUrl to your server's /v1 endpoint\n` +
			`  2. Change apiKey (or leave "ollama" for local servers)\n` +
			`  3. Change the model id/name to what your server exposes\n\n` +
			`Then run /provider reload to pick up changes.\n` +
			`Or use /provider edit to open the file directly.`,
	);
	return { consumed: true };
}

async function editProvider(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const modelsPath = getModelsPath();
	try {
		await fs.access(modelsPath);
	} catch {
		runtime.output(`No models.yml found. Run /provider add first.`);
		return { consumed: true };
	}

	// Try to open in external editor
	const isTui = "ctx" in runtime;
	if (isTui) {
		const ctx = (runtime as TuiSlashCommandRuntime).ctx;
		try {
			await ctx.openExternalEditor(modelsPath);
			runtime.output(`Opened ${modelsPath} in your editor. Run /provider reload when done.`);
		} catch {
			runtime.output(`Could not open editor. Edit manually:\n  ${modelsPath}\nThen run /provider reload.`);
		}
	} else {
		runtime.output(`Edit ${modelsPath} manually, then run /provider reload.`);
	}
	return { consumed: true };
}

async function testProviders(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const modelsPath = getModelsPath();
	let content: string;
	try {
		content = await Bun.file(modelsPath).text();
	} catch {
		runtime.output("No models.yml found. Nothing to test.");
		return { consumed: true };
	}

	// Extract baseUrl and apiKey pairs
	const urls: Array<{ provider: string; url: string; key: string }> = [];
	let currentProvider = "";
	let currentUrl = "";
	let currentKey = "";
	for (const line of content.split("\n")) {
		if (/^\s{2}\S/.test(line) && line.includes(":") && !/baseUrl|apiKey|api:|models:|discovery/.test(line)) {
			if (currentProvider && currentUrl) {
				urls.push({ provider: currentProvider, url: currentUrl, key: currentKey });
			}
			currentProvider = line.trim().replace(/:.*$/, "");
			currentUrl = "";
			currentKey = "";
		}
		if (/baseUrl/.test(line)) {
			currentUrl = line
				.replace(/.*baseUrl:\s*/, "")
				.replace(/["']/g, "")
				.trim();
		}
		if (/apiKey/.test(line)) {
			currentKey = line
				.replace(/.*apiKey:\s*/, "")
				.replace(/["']/g, "")
				.trim();
		}
	}
	if (currentProvider && currentUrl) {
		urls.push({ provider: currentProvider, url: currentUrl, key: currentKey });
	}

	if (urls.length === 0) {
		runtime.output("No providers with a baseUrl found in models.yml.");
		return { consumed: true };
	}

	const results: string[] = [];
	for (const { provider, url, key } of urls) {
		try {
			const response = await fetch(`${url}/models`, {
				headers: key ? { Authorization: `Bearer ${key}` } : {},
				signal: AbortSignal.timeout(8000),
			});
			if (response.ok) {
				results.push(`  ✓ ${provider} — ${url} (connected)`);
			} else {
				results.push(`  ✗ ${provider} — ${url} (HTTP ${response.status})`);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			results.push(`  ✗ ${provider} — ${url} (${msg})`);
		}
	}

	runtime.output(`Provider connectivity:\n${results.join("\n")}`);
	return { consumed: true };
}

async function reloadProviders(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const isTui = "ctx" in runtime;
	if (isTui) {
		const ctx = (runtime as TuiSlashCommandRuntime).ctx;
		try {
			await ctx.session.modelRegistry.refresh("offline");
			const count = ctx.session.modelRegistry.getAvailable().length;
			runtime.output(`✓ Reloaded models.yml — ${count} model(s) available. Use /model to switch.`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			runtime.output(`✗ Reload failed: ${msg}\nCheck your models.yml for syntax errors.`);
		}
	} else {
		runtime.output("Reload is only available in interactive mode.");
	}
	return { consumed: true };
}

export async function handleProviderCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const sub = command.args.trim().toLowerCase();
	switch (sub) {
		case "":
		case "list":
		case "ls":
			return listProviders(runtime);
		case "add":
		case "new":
			return addProvider(runtime);
		case "edit":
		case "config":
			return editProvider(runtime);
		case "test":
		case "check":
			return testProviders(runtime);
		case "reload":
		case "refresh":
			return reloadProviders(runtime);
		default:
			runtime.output(
				`Unknown subcommand: ${sub}\n\nUsage:\n` +
					`  /provider         — list configured providers\n` +
					`  /provider add     — create models.yml with template\n` +
					`  /provider edit    — open models.yml in editor\n` +
					`  /provider test    — test connection to all providers\n` +
					`  /provider reload  — reload after manual edits`,
			);
			return { consumed: true };
	}
}
