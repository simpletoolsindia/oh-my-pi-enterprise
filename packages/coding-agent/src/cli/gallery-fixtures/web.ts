// Gallery fixtures for the web tools (browser).
import type { GalleryFixture } from "./types";

export const webFixtures: Record<string, GalleryFixture> = {
	browser: {
		label: "Browser",
		// Streaming: code body still arriving for a `run` action.
		streamingArgs: {
			action: "run",
			name: "docs",
			code: "const obs = await tab.observe();\n",
		},
		args: {
			action: "run",
			name: "docs",
			code: [
				"const obs = await tab.observe();",
				"const heading = obs.elements.find(e => e.role === 'heading');",
				"display({ url: obs.url, title: obs.title, headings: obs.elements.filter(e => e.role === 'heading').length });",
				"return heading?.name ?? 'no heading found';",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						'{ url: "https://bun.sh/docs", title: "Bun Documentation", headings: 14 }',
						'"Get started with Bun"',
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
				viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
				result: '"Get started with Bun"',
			},
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: [
						"TimeoutError: waiting for selector `aria/Sign in` failed: timeout 30000ms exceeded",
						"    at Tab.waitFor (browser/tab.ts:212:13)",
						"    at run (eval:3:7)",
					].join("\n"),
				},
			],
			details: {
				action: "run",
				name: "docs",
				url: "https://bun.sh/docs",
				browser: "headless",
			},
		},
	},
};
