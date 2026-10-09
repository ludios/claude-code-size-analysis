// Model-output: Claude Opus 5.5

// Builds a self-contained HTML page charting the initial context size of an
// interactive `claude` session over time, one line per model, from
// data/initial_context.jsonl (linux-x64). The tooltip breaks each total into
// system prompt, tool definitions, and injected context messages.

import { readFile, writeFile } from "node:fs/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";
import { render_chart_page } from "./chart_common.ts";

const INPUT_JSONL = "data/initial_context.jsonl";
const OUTPUT_HTML = "data/initial_context_chart.html";

// Fixed series order, most watched first; each series keeps its color slot
// forever, so a series added later must be appended here, never inserted.
const SERIES = [
	{ key: "opus",           slot: 1 },
	{ key: "fable",          slot: 2 },
	{ key: "mythos-preview", slot: 3 },
	{ key: "sonnet",         slot: 4 },
	{ key: "haiku",          slot: 5 },
];

const log = getLogger(["chart"]);

/** One row of data/initial_context.jsonl, as written by measure_context.ts. */
interface ContextRow {
	version: string;
	platform: string;
	release_date: string;
	series: string;
	model: string;
	system: number;
	tools: number;
	tool_count: number;
	messages: number;
	total: number;
}

/** The aligned dataset embedded into the page; [series][version] arrays hold null where a version lacks the series. */
interface ChartData {
	/** Unix timestamps in seconds, one per version, strictly increasing. */
	timestamps: number[];
	/** Version string for each timestamp. */
	versions: string[];
	/** Series keys in fixed color-slot order. */
	series: string[];
	/** Palette slot per series, same order. */
	slots: number[];
	/** Model ID each version resolved the series to. */
	models: (string | null)[][];
	/** Sizes in UTF-8 bytes. */
	system: (number | null)[][];
	tools: (number | null)[][];
	messages: (number | null)[][];
	totals: (number | null)[][];
}

/**
 * Align the rows into one x axis of versions.
 * @param rows parsed rows of the context JSONL, any order
 * @returns dataset ready for embedding, oldest version first
 */
function build_chart_data(rows: ContextRow[]): ChartData {
	A.gt(rows.length, 0, `no rows in ${INPUT_JSONL}`);
	const keys = SERIES.map((s) => s.key);
	const by_version = new Map<string, { time_ms: number, by_series: Map<string, ContextRow> }>();
	for (const row of rows) {
		A(keys.includes(row.series), () => `unknown series ${row.series}; add it to SERIES`);
		A.eq(row.system + row.tools + row.messages, row.total, () => `${row.version} ${row.series}: parts do not sum to total`);
		let group = by_version.get(row.version);
		if (group === undefined) {
			group = { time_ms: Date.parse(row.release_date), by_series: new Map() };
			by_version.set(row.version, group);
		}
		A.eq(Date.parse(row.release_date), group.time_ms, () => `${row.version}: rows disagree on the release time`);
		A(!group.by_series.has(row.series), () => `duplicate ${row.version} ${row.series}`);
		group.by_series.set(row.series, row);
	}

	const ordered = [...by_version.entries()].toSorted((a, b) => a[1].time_ms - b[1].time_ms);
	for (let i = 1; i < ordered.length; i++) {
		A.lt(ordered[i - 1]![1].time_ms, ordered[i]![1].time_ms, () => `versions ${ordered[i - 1]![0]} and ${ordered[i]![0]} share a release time`);
	}
	const per_series = <T>(pick: (row: ContextRow) => T) =>
		keys.map((key) => ordered.map(([, g]) => {
			const row = g.by_series.get(key);
			return row === undefined ? null : pick(row);
		}));
	return {
		timestamps: ordered.map(([, g]) => Math.round(g.time_ms / 1000)),
		versions:   ordered.map(([version]) => version),
		series:     keys,
		slots:      SERIES.map((s) => s.slot),
		models:     per_series((r) => r.model),
		system:     per_series((r) => r.system),
		tools:      per_series((r) => r.tools),
		messages:   per_series((r) => r.messages),
		totals:     per_series((r) => r.total),
	};
}

const CLIENT_JS = `
function fmt_kb(bytes) {
	return (bytes / 1e3).toFixed(1);
}

function make_plot(shown) {
	shown = shown ?? DATA.series.map(() => true);
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
				label:     "initial context (KB)",
				labelSize: 24,
				stroke:    css_var("--text-muted"),
				grid:      { stroke: css_var("--gridline"), width: 1 },
				ticks:     { show: false },
				values:    (u, splits) => splits.map((v) => Math.round(v / 1e3)),
			},
		],
		series: [
			{},
			...DATA.series.map((key, s) => ({
				label:    key,
				show:     shown[s],
				stroke:   css_var("--series-" + DATA.slots[s]),
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
	return new uPlot(opts, [DATA.timestamps, ...DATA.totals], chart_el);
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
	const head  = table.insertRow();
	head.insertCell();
	head.insertCell();
	for (const title of ["total", "system", "tools", "messages"]) {
		const cell = head.insertCell();
		cell.className   = "tt-value tt-name";
		cell.textContent = title;
	}
	for (let s = 0; s < DATA.series.length; s++) {
		if (!u.series[s + 1].show || DATA.totals[s][idx] === null) {
			continue;
		}
		const row = table.insertRow();
		const key = document.createElement("span");
		key.className = "tt-key";
		key.style.background = css_var("--series-" + DATA.slots[s]);
		row.insertCell().appendChild(key);
		const name = row.insertCell();
		name.className          = "tt-name";
		name.style.paddingRight = "8px";
		name.textContent        = DATA.series[s];
		for (const part of [DATA.totals, DATA.system, DATA.tools, DATA.messages]) {
			const value = row.insertCell();
			value.className   = "tt-value";
			value.textContent = fmt_kb(part[s][idx]);
		}
		const model = row.insertCell();
		model.className   = "tt-name";
		model.textContent = DATA.models[s][idx];
	}
	tooltip_el.append(version, date, table);
}`;

const TABLE_JS = `
	const head = table_el.createTHead().insertRow();
	for (const title of ["Version", "Date", ...DATA.series]) {
		const th = document.createElement("th");
		th.textContent = title;
		head.appendChild(th);
	}
	const body = table_el.createTBody();
	for (let idx = DATA.versions.length - 1; idx >= 0; idx--) {
		const row = body.insertRow();
		row.insertCell().textContent = DATA.versions[idx];
		row.insertCell().textContent = fmt_date(DATA.timestamps[idx]);
		for (let s = 0; s < DATA.series.length; s++) {
			const total = DATA.totals[s][idx];
			row.insertCell().textContent = total === null ? "\\u2014" : fmt_kb(total);
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
	const rows  = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as ContextRow);
	const data  = build_chart_data(rows);
	const page  = await render_chart_page({
		title:         "claude initial context size",
		subtitle_html: "What an interactive <code>claude --model &lt;series&gt;</code> session sends before any work: system prompt, tool definitions, and the context messages injected around the first user turn (the typed prompt itself excluded). Captured offline, with an empty home directory and a fresh non-git working directory: no CLAUDE.md, MCP servers, or plugins.",
		footer_html:   "Generated by src/build_context_chart.ts from data/initial_context.jsonl (linux-x64 binaries). Sizes in KB (10&sup3; bytes) of UTF-8 text; tool definitions measured as their JSON.",
		table_summary: "Data table (KB, total)",
		data,
		client_js:     CLIENT_JS,
		table_js:      TABLE_JS,
	});
	await writeFile(OUTPUT_HTML, page);
	log.info(`wrote ${OUTPUT_HTML}: ${data.versions.length} versions x ${data.series.length} series`);
}

await main();
