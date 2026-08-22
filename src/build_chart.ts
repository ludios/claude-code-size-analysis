// Model-output: Claude Fable 5

// Builds a self-contained HTML page charting the size of the bundled `claude`
// binary over time, one line per target platform, from data/vsix_sizes.jsonl.
// uPlot and the data are inlined so the page works from file:// with no server.

import { readFile, writeFile } from "node:fs/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const INPUT_JSONL  = "data/vsix_sizes.jsonl";
const OUTPUT_HTML  = "data/claude_size_chart.html";
const UPLOT_JS     = "node_modules/uplot/dist/uPlot.iife.min.js";
const UPLOT_CSS    = "node_modules/uplot/dist/uPlot.min.css";

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

/**
 * @param data dataset to embed
 * @param uplot_js uPlot IIFE bundle source
 * @param uplot_css uPlot stylesheet source
 * @returns the complete HTML page
 */
function render_page(data: ChartData, uplot_js: string, uplot_css: string): string {
	// "<" must not appear in inline <script> content (it could open "</script>").
	const data_json = JSON.stringify(data).replaceAll("<", "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>claude binary size by platform</title>
<style>
${uplot_css}
:root {
	color-scheme: light;
	--page:           #f9f9f7;
	--surface-1:      #fcfcfb;
	--text-primary:   #0b0b0b;
	--text-secondary: #52514e;
	--text-muted:     #898781;
	--gridline:       #e1e0d9;
	--baseline:       #c3c2b7;
	--border:         rgba(11, 11, 11, 0.10);
	--series-1: #2a78d6;
	--series-2: #eb6834;
	--series-3: #1baf7a;
	--series-4: #eda100;
	--series-5: #e87ba4;
	--series-6: #008300;
	--series-7: #4a3aa7;
	--series-8: #e34948;
}
@media (prefers-color-scheme: dark) {
	:root:where(:not([data-theme="light"])) {
		color-scheme: dark;
		--page:           #0d0d0d;
		--surface-1:      #1a1a19;
		--text-primary:   #ffffff;
		--text-secondary: #c3c2b7;
		--text-muted:     #898781;
		--gridline:       #2c2c2a;
		--baseline:       #383835;
		--border:         rgba(255, 255, 255, 0.10);
		--series-1: #3987e5;
		--series-2: #d95926;
		--series-3: #199e70;
		--series-4: #c98500;
		--series-5: #d55181;
		--series-6: #008300;
		--series-7: #9085e9;
		--series-8: #e66767;
	}
}
:root[data-theme="dark"] {
	color-scheme: dark;
	--page:           #0d0d0d;
	--surface-1:      #1a1a19;
	--text-primary:   #ffffff;
	--text-secondary: #c3c2b7;
	--text-muted:     #898781;
	--gridline:       #2c2c2a;
	--baseline:       #383835;
	--border:         rgba(255, 255, 255, 0.10);
	--series-1: #3987e5;
	--series-2: #d95926;
	--series-3: #199e70;
	--series-4: #c98500;
	--series-5: #d55181;
	--series-6: #008300;
	--series-7: #9085e9;
	--series-8: #e66767;
}
* {
	box-sizing: border-box;
}
body {
	margin: 0;
	background: var(--page);
	color: var(--text-primary);
	font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
main {
	max-width: 1100px;
	margin: 0 auto;
	padding: 24px 20px 48px;
}
h1 {
	font-size: 20px;
	margin: 0 0 4px;
}
.subtitle {
	margin: 0 0 20px;
	color: var(--text-secondary);
	font-size: 14px;
}
.chart-card {
	background: var(--surface-1);
	border: 1px solid var(--border);
	border-radius: 8px;
	padding: 16px 16px 8px;
}
#chart .u-legend {
	color: var(--text-secondary);
	font: 12px system-ui, -apple-system, "Segoe UI", sans-serif;
	margin-top: 4px;
}
#chart .u-legend .u-inline th {
	font-weight: 500;
}
#chart .u-legend .u-inline tr.u-off th {
	color: var(--text-muted);
}
.legend-hint {
	margin: 4px 0 0;
	color: var(--text-muted);
	font-size: 12px;
}
#tooltip {
	position: absolute;
	display: none;
	pointer-events: none;
	z-index: 10;
	background: var(--surface-1);
	border: 1px solid var(--border);
	border-radius: 6px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
	padding: 8px 10px;
	font-size: 12px;
	white-space: nowrap;
}
#tooltip .tt-version {
	font-weight: 600;
	color: var(--text-primary);
}
#tooltip .tt-date {
	color: var(--text-muted);
	margin-bottom: 6px;
}
#tooltip table {
	border-collapse: collapse;
}
#tooltip td {
	padding: 1px 0;
}
#tooltip .tt-key {
	display: inline-block;
	width: 14px;
	height: 2px;
	vertical-align: middle;
	margin-right: 6px;
}
#tooltip .tt-value {
	font-weight: 600;
	color: var(--text-primary);
	text-align: right;
	padding-right: 8px;
	font-variant-numeric: tabular-nums;
}
#tooltip .tt-name {
	color: var(--text-secondary);
}
.table-view {
	margin-top: 20px;
	color: var(--text-secondary);
}
.table-view summary {
	cursor: pointer;
	font-size: 14px;
}
.table-scroll {
	overflow-x: auto;
	margin-top: 8px;
	background: var(--surface-1);
	border: 1px solid var(--border);
	border-radius: 8px;
}
.table-view table {
	border-collapse: collapse;
	font-size: 13px;
	width: 100%;
}
.table-view th, .table-view td {
	padding: 4px 12px;
	text-align: right;
	font-variant-numeric: tabular-nums;
	white-space: nowrap;
}
.table-view th {
	color: var(--text-secondary);
	font-weight: 600;
	border-bottom: 1px solid var(--gridline);
	position: sticky;
	top: 0;
	background: var(--surface-1);
}
.table-view th:first-child, .table-view td:first-child {
	text-align: left;
}
.table-view td {
	color: var(--text-primary);
	border-bottom: 1px solid var(--gridline);
}
footer {
	margin-top: 16px;
	color: var(--text-muted);
	font-size: 12px;
}
</style>
<script>
${uplot_js}
</script>
</head>
<body>
<main>
<h1>claude binary size</h1>
<p class="subtitle">Uncompressed size of the \`claude\` binary bundled in each anthropic.claude-code .vsix, by target platform. Universal (no-binary) packages are excluded.</p>
<div class="chart-card">
	<div id="chart"></div>
	<p class="legend-hint">Click a legend entry to hide or show its platform.</p>
</div>
<details class="table-view">
	<summary>Data table (MB per platform)</summary>
	<div class="table-scroll"><table id="data-table"></table></div>
</details>
<footer>Generated by src/build_chart.ts from data/vsix_sizes.jsonl. Sizes in MB (10&#8310; bytes).</footer>
</main>
<script>
"use strict";
const DATA = ${data_json};

// Allow ?theme=dark / ?theme=light for testing the two palettes.
const theme_override = new URLSearchParams(location.search).get("theme");
if (theme_override === "dark" || theme_override === "light") {
	document.documentElement.dataset["theme"] = theme_override;
}

function css_var(name) {
	return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function fmt_mb(bytes) {
	return (bytes / 1e6).toFixed(1);
}

function fmt_date(ts) {
	return new Date(ts * 1000).toISOString().slice(0, 10);
}

const chart_el   = document.getElementById("chart");
const tooltip_el = document.createElement("div");
tooltip_el.id = "tooltip";

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
}

function place_tooltip(u) {
	const idx = u.cursor.idx;
	if (idx == null || u.cursor.left < 0) {
		tooltip_el.style.display = "none";
		return;
	}
	build_tooltip(u, idx);
	tooltip_el.style.display = "block";
	const over = u.over.getBoundingClientRect();
	const wrap = chart_el.getBoundingClientRect();
	const base_left = over.left - wrap.left + u.cursor.left;
	const flip = u.cursor.left > u.over.clientWidth - tooltip_el.offsetWidth - 24;
	tooltip_el.style.left = (flip ? base_left - tooltip_el.offsetWidth - 12 : base_left + 12) + "px";
	tooltip_el.style.top  = (over.top - wrap.top + Math.min(u.cursor.top, u.over.clientHeight - tooltip_el.offsetHeight)) + "px";
}

function make_plot(shown) {
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
				label:       "claude binary size (MB)",
				labelSize:   24,
				stroke:      css_var("--text-muted"),
				grid:        { stroke: css_var("--gridline"), width: 1 },
				ticks:       { show: false },
				values:      (u, splits) => splits.map((v) => Math.round(v / 1e6)),
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

// Plot creation waits until the container has been laid out and has a real
// width: an end-of-body script (and even the first animation frame, in
// headless browsers) can run while chart_el.clientWidth is still 0. The
// ResizeObserver fires once layout assigns a size, and again on any resize.
let plot = null;
chart_el.style.position = "relative";
new ResizeObserver(() => {
	const width = chart_el.clientWidth;
	if (width === 0) {
		return;
	}
	if (plot === null) {
		plot = make_plot(DATA.platforms.map(() => true));
		chart_el.appendChild(tooltip_el);
	} else {
		plot.setSize({ width, height: 420 });
	}
	apply_cursor_override();
}).observe(chart_el);

// ?cursor=N pins the cursor to version index N, so the tooltip can be
// inspected in a headless screenshot. Re-applied after each (re)layout,
// because a plot created or resized before layout settles cannot map a
// timestamp to a pixel position yet.
const cursor_override = new URLSearchParams(location.search).get("cursor");
function apply_cursor_override() {
	if (cursor_override === null) {
		return;
	}
	const idx = Number(cursor_override);
	const pos = plot.valToPos(DATA.timestamps[idx], "x");
	if (pos !== null) {
		plot.setCursor({ left: pos, top: 120 });
	}
}

// Series colors differ between light and dark; rebuild on scheme change,
// preserving which series the reader has toggled off.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
	if (plot === null) {
		return;
	}
	const shown = plot.series.slice(1).map((s) => s.show);
	plot.destroy();
	plot = make_plot(shown);
	chart_el.appendChild(tooltip_el);
});

// Table view: the keyboard/no-hover twin of the tooltip.
const table_el = document.getElementById("data-table");
{
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
			row.insertCell().textContent = size === null ? "—" : fmt_mb(size);
		}
	}
}
</script>
</body>
</html>
`;
}

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
	const page  = render_page(data, await readFile(UPLOT_JS, "utf8"), await readFile(UPLOT_CSS, "utf8"));
	await writeFile(OUTPUT_HTML, page);
	log.info(`wrote ${OUTPUT_HTML}: ${data.versions.length} versions x ${data.platforms.length} platforms`);
}

await main();
