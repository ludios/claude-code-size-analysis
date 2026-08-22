// Model-output: Claude Fable 5

// Builds a self-contained HTML page with a stacked area chart of what the
// `claude` binary is made of over time (Bun runtime, JSC bytecode, JS bundle,
// native addons, vendored assets, graph overhead), from the per-version
// component sizes in data/bun_composition.jsonl (linux-x64).

import { readFile, writeFile } from "node:fs/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";
import { render_chart_page } from "./chart_common.ts";

const INPUT_JSONL = "data/bun_composition.jsonl";
const OUTPUT_HTML = "data/claude_composition_chart.html";

// Stack order, bottom to top; each component keeps its palette slot forever.
// Slot 6 (green) is skipped: beside slot 3 (aqua) it would read as a second
// green, so "other" takes slot 7 (violet) instead — this 1,2,3,4,5,7 sequence
// passes the palette validator's adjacent-pair checks in both modes.
const COMPONENTS = [
	{ key: "runtime",         label: "Bun runtime",     slot: 1 },
	{ key: "js_bundle",       label: "JS bundle",       slot: 2 },
	{ key: "bytecode",        label: "JSC bytecode",    slot: 3 },
	{ key: "native_addons",   label: "native addons",   slot: 4 },
	{ key: "vendored_assets", label: "vendored assets", slot: 5 },
	{ key: "other",           label: "other",           slot: 7 },
] as const;

const log = getLogger(["chart"]);

/** One row of data/bun_composition.jsonl, as written by analyze_bun.ts. */
interface CompositionRow {
	version: string;
	platform: string;
	release_date: string;
	file_size: number;
	runtime: number;
	bytecode: number;
	js_bundle: number;
	native_addons: number;
	vendored_assets: number;
	other: number;
}

/** The dataset embedded into the page. */
interface ChartData {
	/** Unix timestamps in seconds, one per version, strictly increasing. */
	timestamps: number[];
	/** Version string for each timestamp. */
	versions: string[];
	/** Component labels in stack order, bottom first. */
	labels: string[];
	/** Palette slot per component, same order as labels. */
	slots: number[];
	/** Component sizes in bytes, [component][version], same order as labels. */
	components: number[][];
}

/**
 * @param rows parsed composition rows, any order
 * @returns dataset ready for embedding, oldest version first
 */
function build_chart_data(rows: CompositionRow[]): ChartData {
	A.gt(rows.length, 0, `no rows in ${INPUT_JSONL}`);
	const ordered = rows.toSorted((a, b) => Date.parse(a.release_date) - Date.parse(b.release_date));
	for (let i = 1; i < ordered.length; i++) {
		A.lt(Date.parse(ordered[i - 1]!.release_date), Date.parse(ordered[i]!.release_date),
			() => `versions ${ordered[i - 1]!.version} and ${ordered[i]!.version} share a release time`);
	}
	for (const row of ordered) {
		const sum = COMPONENTS.reduce((acc, c) => acc + row[c.key], 0);
		A.eq(sum, row.file_size, () => `${row.version}: components do not sum to file_size`);
	}
	return {
		timestamps: ordered.map((r) => Math.round(Date.parse(r.release_date) / 1000)),
		versions:   ordered.map((r) => r.version),
		labels:     COMPONENTS.map((c) => c.label),
		slots:      COMPONENTS.map((c) => c.slot),
		components: COMPONENTS.map((c) => ordered.map((r) => r[c.key])),
	};
}

// Client script: stacked areas via cumulative sums over the visible series,
// with uPlot bands filling each series down to the next visible one below.
// Toggling a series restacks, so a rebuild is scheduled from the setSeries
// hook. Tooltip shows the raw (unstacked) component sizes plus the total.
const CLIENT_JS = `
function stacked_data(shown) {
	const n   = DATA.timestamps.length;
	const sum = new Array(n).fill(0);
	const stacked = DATA.components.map((series, s) => {
		if (!shown[s]) {
			return series.slice();
		}
		return series.map((v, i) => (sum[i] += v));
	});
	return [DATA.timestamps, ...stacked];
}

function make_plot(shown) {
	shown = shown ?? DATA.labels.map(() => true);
	const bands = [];
	let below = null;
	for (let s = 0; s < DATA.labels.length; s++) {
		if (!shown[s]) {
			continue;
		}
		if (below !== null) {
			bands.push({ series: [s + 1, below + 1] });
		}
		below = s;
	}
	let restacking = false;
	const opts = {
		width:  chart_el.clientWidth,
		height: 440,
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
				label:     "size (MB)",
				labelSize: 24,
				stroke:    css_var("--text-muted"),
				grid:      { stroke: css_var("--gridline"), width: 1 },
				ticks:     { show: false },
				values:    (u, splits) => splits.map((v) => Math.round(v / 1e6)),
			},
		],
		series: [
			{},
			...DATA.labels.map((label, s) => ({
				label,
				show:   shown[s],
				stroke: css_var("--series-" + DATA.slots[s]),
				fill:   css_var("--series-" + DATA.slots[s]) + "59",
				width:  2,
				points: { show: false },
			})),
		],
		bands,
		cursor: {
			points: { size: 8 },
			y:      false,
		},
		legend: { live: false },
		hooks: {
			setCursor: [place_tooltip],
			setSeries: [
				(u, sidx) => {
					// Restack when the reader toggles a series; deferred because
					// uPlot is mid-event, and guarded against rebuild recursion.
					if (sidx !== null && !restacking) {
						restacking = true;
						requestAnimationFrame(() => rebuild_plot());
					}
				},
			],
		},
	};
	return new uPlot(opts, stacked_data(shown), chart_el);
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
	let total = 0;
	for (let s = DATA.labels.length - 1; s >= 0; s--) {
		if (!u.series[s + 1].show) {
			continue;
		}
		total += DATA.components[s][idx];
		const row = table.insertRow();
		const key = document.createElement("span");
		key.className = "tt-key";
		key.style.background = css_var("--series-" + DATA.slots[s]);
		row.insertCell().appendChild(key);
		const value = row.insertCell();
		value.className   = "tt-value";
		value.textContent = fmt_mb(DATA.components[s][idx]) + " MB";
		const name = row.insertCell();
		name.className   = "tt-name";
		name.textContent = DATA.labels[s];
	}
	const row = table.insertRow();
	row.insertCell();
	const value = row.insertCell();
	value.className   = "tt-value";
	value.textContent = fmt_mb(total) + " MB";
	const name = row.insertCell();
	name.className   = "tt-name";
	name.textContent = "total";
	tooltip_el.append(version, date, table);
}`;

const TABLE_JS = `
	const head = table_el.createTHead().insertRow();
	for (const title of ["Version", "Date", ...DATA.labels, "total"]) {
		const th = document.createElement("th");
		th.textContent = title;
		head.appendChild(th);
	}
	const body = table_el.createTBody();
	for (let idx = DATA.versions.length - 1; idx >= 0; idx--) {
		const row = body.insertRow();
		row.insertCell().textContent = DATA.versions[idx];
		row.insertCell().textContent = fmt_date(DATA.timestamps[idx]);
		let total = 0;
		for (let s = 0; s < DATA.labels.length; s++) {
			total += DATA.components[s][idx];
			row.insertCell().textContent = fmt_mb(DATA.components[s][idx]);
		}
		row.insertCell().textContent = fmt_mb(total);
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
	const rows  = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as CompositionRow);
	const data  = build_chart_data(rows);
	const page  = await render_chart_page({
		title:         "claude binary composition",
		subtitle_html: "",
		footer_html:   "Generated by src/build_composition_chart.ts from data/bun_composition.jsonl. Sizes in MB (10&#8310; bytes), uncompressed.",
		data,
		client_js:     CLIENT_JS,
		table_js:      TABLE_JS,
	});
	await writeFile(OUTPUT_HTML, page);
	log.info(`wrote ${OUTPUT_HTML}: ${data.versions.length} versions x ${data.labels.length} components`);
}

await main();
