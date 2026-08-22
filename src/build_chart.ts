// Model-output: Claude Fable 5

// Builds a self-contained HTML page charting the size of the bundled `claude`
// binary over time, one line per target platform, from data/vsix_sizes.jsonl.
// uPlot and the data are inlined so the page works from file:// with no server.

import { readFile, writeFile } from "node:fs/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";
import { render_chart_page } from "./chart_common.ts";

const INPUT_JSONL = "data/vsix_sizes.jsonl";
const OUTPUT_HTML = "data/claude_size_chart.html";

// Fixed platform order; each platform keeps its color slot forever, so a
// platform added later must be appended here, never inserted.
const PLATFORMS = [
	"alpine-arm64",
	"alpine-x64",
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"win32-arm64",
	"win32-x64",
];

const log = getLogger(["chart"]);

/** One row of data/vsix_sizes.jsonl, as written by process_vsix.ts. */
interface VsixRow {
	vsix_file: string;
	platform: string;
	version: string;
	release_date: string;
	vsix_size: number;
	extension_js_size: number;
	claude_size: number | null;
}

/** The aligned dataset embedded into the page for uPlot. */
interface ChartData {
	/** Unix timestamps in seconds, one per version, strictly increasing. */
	timestamps: number[];
	/** Version string for each timestamp, e.g. "2.1.239". */
	versions: string[];
	/** Platform names in fixed color-slot order. */
	platforms: string[];
	/** claude binary size in bytes, [platform][version]; null where that platform has no package. */
	sizes: (number | null)[][];
}

/**
 * Align rows that have a claude binary into one x axis of versions. Each
 * version is placed at the earliest release time among its platform packages,
 * since the marketplace publishes all platforms of a version within a short
 * window.
 * @param rows parsed rows of the sizes JSONL
 * @returns dataset ready for embedding
 */
function build_chart_data(rows: VsixRow[]): ChartData {
	const with_binary = rows.filter((row) => row.claude_size !== null);
	A.gt(with_binary.length, 0, "no rows with a claude binary");
	for (const row of with_binary) {
		A(PLATFORMS.includes(row.platform), () => `unknown platform ${row.platform}; add it to PLATFORMS (color slots are limited to 8)`);
	}

	interface VersionGroup {
		time_ms: number;
		size_by_platform: Map<string, number>;
	}
	const by_version = new Map<string, VersionGroup>();
	for (const row of with_binary) {
		const time_ms = Date.parse(row.release_date);
		A(Number.isFinite(time_ms), () => `${row.vsix_file}: bad release_date ${row.release_date}`);
		let group = by_version.get(row.version);
		if (group === undefined) {
			group = { time_ms, size_by_platform: new Map() };
			by_version.set(row.version, group);
		}
		group.time_ms = Math.min(group.time_ms, time_ms);
		A(!group.size_by_platform.has(row.platform), () => `duplicate ${row.version}-${row.platform}`);
		group.size_by_platform.set(row.platform, row.claude_size!);
	}

	const ordered = [...by_version.entries()].toSorted((a, b) => a[1].time_ms - b[1].time_ms);
	for (let i = 1; i < ordered.length; i++) {
		A.lt(ordered[i - 1]![1].time_ms, ordered[i]![1].time_ms, () => `versions ${ordered[i - 1]![0]} and ${ordered[i]![0]} share a release time`);
	}
	return {
		timestamps: ordered.map(([, g]) => Math.round(g.time_ms / 1000)),
		versions:   ordered.map(([version]) => version),
		platforms:  PLATFORMS,
		sizes:      PLATFORMS.map((platform) => ordered.map(([, g]) => g.size_by_platform.get(platform) ?? null)),
	};
}

const CLIENT_JS = `
function make_plot(shown) {
	shown = shown ?? DATA.platforms.map(() => true);
	const opts = {
		width:  chart_el.clientWidth,
		height: 420,
		scales: {
			y: { range: (u, min, max) => [0, max * 1.04] },
		},
		axes: [
			{
				stroke: css_var("--text-muted"),
				grid:   { stroke: css_var("--gridline"), width: 1 },
				ticks:  { stroke: css_var("--baseline"), width: 1 },
			},
			{
				label:     "claude binary size (MB)",
				labelSize: 24,
				stroke:    css_var("--text-muted"),
				grid:      { stroke: css_var("--gridline"), width: 1 },
				ticks:     { show: false },
				values:    (u, splits) => splits.map((v) => Math.round(v / 1e6)),
			},
		],
		series: [
			{},
			...DATA.platforms.map((platform, s) => ({
				label:    platform,
				show:     shown[s],
				stroke:   css_var("--series-" + (s + 1)),
				width:    2,
				spanGaps: true,
				points:   { show: false },
			})),
		],
		cursor: {
			points: { size: 8 },
			y:      false,
		},
		legend: { live: false },
		hooks: {
			setCursor: [place_tooltip],
		},
	};
	return new uPlot(opts, [DATA.timestamps, ...DATA.sizes], chart_el);
}

function build_tooltip(u, idx) {
	tooltip_el.replaceChildren();
	const version = document.createElement("div");
	version.className   = "tt-version";
	version.textContent = "v" + DATA.versions[idx];
	const date = document.createElement("div");
	date.className   = "tt-date";
	date.textContent = fmt_date(DATA.timestamps[idx]);
	const table = document.createElement("table");
	for (let s = 0; s < DATA.platforms.length; s++) {
		if (!u.series[s + 1].show) {
			continue;
		}
		const size = DATA.sizes[s][idx];
		if (size === null) {
			continue;
		}
		const row = table.insertRow();
		const key = document.createElement("span");
		key.className = "tt-key";
		key.style.background = css_var("--series-" + (s + 1));
		row.insertCell().appendChild(key);
		const value = row.insertCell();
		value.className   = "tt-value";
		value.textContent = fmt_mb(size) + " MB";
		const name = row.insertCell();
		name.className   = "tt-name";
		name.textContent = DATA.platforms[s];
	}
	tooltip_el.append(version, date, table);
}`;

const TABLE_JS = `
	const head = table_el.createTHead().insertRow();
	for (const title of ["Version", "Date", ...DATA.platforms]) {
		const th = document.createElement("th");
		th.textContent = title;
		head.appendChild(th);
	}
	const body = table_el.createTBody();
	for (let idx = DATA.versions.length - 1; idx >= 0; idx--) {
		const row = body.insertRow();
		row.insertCell().textContent = DATA.versions[idx];
		row.insertCell().textContent = fmt_date(DATA.timestamps[idx]);
		for (let s = 0; s < DATA.platforms.length; s++) {
			const size = DATA.sizes[s][idx];
			row.insertCell().textContent = size === null ? "\\u2014" : fmt_mb(size);
		}
	}`;

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "chart",             sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
		],
	});
	const jsonl = await readFile(INPUT_JSONL, "utf8");
	const rows  = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as VsixRow);
	const data  = build_chart_data(rows);
	const page  = await render_chart_page({
		title:         "claude binary size",
		subtitle_html: "Uncompressed size of the `claude` binary bundled in each anthropic.claude-code .vsix, by target platform. Universal (no-binary) packages are excluded.",
		footer_html:   "Generated by src/build_chart.ts from data/vsix_sizes.jsonl. Sizes in MB (10&#8310; bytes).",
		data,
		client_js:     CLIENT_JS,
		table_js:      TABLE_JS,
	});
	await writeFile(OUTPUT_HTML, page);
	log.info(`wrote ${OUTPUT_HTML}: ${data.versions.length} versions x ${data.platforms.length} platforms`);
}

await main();
