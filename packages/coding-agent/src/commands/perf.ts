/**
 * `omp perf` — local performance measurement.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { perfHelp as commandHelp } from "../cli/command-help";
import { type PerfCommandArgs, runPerfReport } from "../cli/perf-cli";

export default class Perf extends Command {
	static description = commandHelp.description;
	static flags = {
		json: Flags.boolean({ char: "j", description: "Output JSON", default: false }),
	};

	async run(): Promise<void> {
		const { flags } = await this.parse(Perf);
		const cmd: PerfCommandArgs = { json: flags.json };
		await runPerfReport(cmd);
	}
}
