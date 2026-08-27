/**
 * First-run code graph index build. Shown once per project (whenever
 * `.omp/codegraph.db` doesn't exist yet in the workspace) as a blocking
 * full-screen overlay before the interactive chat surface becomes usable —
 * mirrors `startup-splash.ts`'s "run before the main loop starts" shape, but
 * driven by real progress-stage callbacks from the in-process indexer instead
 * of a fixed timer.
 */
import { type Component, type OverlayFocusOwner, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import { buildIndex, isIndexed } from "../../utils/local-code-graph";
import { theme } from "../theme/theme";
import type { InteractiveModeContext } from "../types";

const TICK_MS = 90;
const BAR_WIDTH = 24;

function padLine(line: string, width: number): string {
	const visible = visibleWidth(line);
	return visible >= width ? truncateToWidth(line, width) : `${line}${" ".repeat(width - visible)}`;
}

/** A bouncing indeterminate marquee — codegraph's CLI doesn't report a percentage. */
function marqueeBar(tick: number, width: number): string {
	const barWidth = Math.max(8, Math.min(BAR_WIDTH, width));
	const segment = Math.max(2, Math.floor(barWidth / 4));
	const span = barWidth - segment;
	const phase = tick % (span * 2);
	const pos = phase <= span ? phase : span * 2 - phase;
	const before = "░".repeat(pos);
	const filled = "█".repeat(segment);
	const after = "░".repeat(barWidth - pos - segment);
	return `${theme.fg("muted", before)}${theme.fg("accent", filled)}${theme.fg("muted", after)}`;
}

class CodegraphScanOverlayComponent implements Component, OverlayFocusOwner {
	#status = "Starting…";
	#tick = 0;
	#timer: ReturnType<typeof setInterval> | undefined;

	constructor(readonly ctx: InteractiveModeContext) {}

	setStatus(status: string): void {
		this.#status = status;
		this.ctx.ui.requestRender();
	}

	async run(cwd: string, signal?: AbortSignal): Promise<void> {
		this.#startTimer();
		this.ctx.ui.requestRender();
		try {
			await buildIndex(cwd, stage => this.setStatus(stage), signal);
		} catch (error) {
			logger.warn("Code graph initial scan failed", { error: String(error) });
		} finally {
			this.#stopTimer();
		}
	}

	dispose(): void {
		this.#stopTimer();
	}

	ownsOverlayFocusTarget(component: Component): boolean {
		return component === this;
	}

	// Blocking startup step — no user input is accepted (nothing to cancel into;
	// the scan runs to completion or the process is interrupted like any other
	// startup work).
	handleInput(): void {}

	render(width: number): readonly string[] {
		const w = Math.max(20, width);
		const border = theme.fg("border", theme.boxRound.horizontal.repeat(w));
		const title = theme.fg("accent", "Indexing code graph") + theme.fg("muted", " (first run for this project)");
		const bar = marqueeBar(this.#tick, Math.max(8, w - 4));
		const status = theme.fg("muted", this.#status);
		return [border, padLine(` ${title}`, w), padLine(` ${bar}`, w), padLine(` ${status}`, w), border];
	}

	#startTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			this.#tick++;
			this.ctx.ui.requestRender();
		}, TICK_MS);
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}
}

/**
 * Runs the first-time code graph scan as a blocking startup overlay, if (and
 * only if) codegraph is enabled and this project hasn't been indexed yet.
 * No-op otherwise — returns immediately.
 */
export async function runCodegraphScanIfNeeded(
	ctx: InteractiveModeContext,
	cwd: string,
	enabled: boolean,
	signal?: AbortSignal,
): Promise<void> {
	if (!enabled) return;
	if (isIndexed(cwd)) return;

	const component = new CodegraphScanOverlayComponent(ctx);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		ctx.ui.setFocus(component);
		await component.run(cwd, signal);
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
}
