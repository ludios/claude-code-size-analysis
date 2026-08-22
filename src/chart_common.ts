// Model-output: Claude Fable 5

// Shared scaffolding for the self-contained uPlot chart pages: theme tokens,
// page skeleton, and the client-side helpers (theming, tooltip placement,
// layout-aware plot creation). Each page supplies its data, a make_plot()
// building its uPlot options, and a build_tooltip() rendering tooltip rows.

import { readFile } from "node:fs/promises";

const UPLOT_JS  = "node_modules/uplot/dist/uPlot.iife.min.js";
const UPLOT_CSS = "node_modules/uplot/dist/uPlot.min.css";

/** Inputs for one chart page. */
export interface ChartPage {
	/** Page <title> and <h1>. */
	title: string;
	/** Subtitle paragraph, as HTML. */
	subtitle_html: string;
	/** Footer line, as HTML. */
	footer_html: string;
	/** Data object embedded as `const DATA = ...` for the client script. */
	data: unknown;
	/** Client script defining make_plot(shown) and build_tooltip(u, idx); runs after the shared helpers. */
	client_js: string;
	/** HTML for the table view, placed inside the <table> element builder script. */
	table_js: string;
}

// Categorical palette and chart chrome from the validated reference palette
// (dataviz skill); the dark column is the same hues re-stepped for the dark
// surface, applied via both the OS media query and an explicit data-theme.
const THEME_TOKENS_LIGHT = `
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
	--series-8: #e34948;`;

const THEME_TOKENS_DARK = `
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
	--series-8: #e66767;`;

const PAGE_CSS = `
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
}`;

// Client-side helpers shared by the chart pages. The page's client_js runs
// after this and must define make_plot(shown) and build_tooltip(u, idx);
// n_series() reads the series count from make_plot's option template.
const HELPERS_JS = `
"use strict";

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
	const left = flip ? base_left - tooltip_el.offsetWidth - 12 : base_left + 12;
	// In a viewport narrower than the tooltip both sides overflow; clamp so the
	// version and sizes stay readable.
	tooltip_el.style.left = Math.max(0, Math.min(left, wrap.width - tooltip_el.offsetWidth)) + "px";
	tooltip_el.style.top  = (over.top - wrap.top + Math.min(u.cursor.top, u.over.clientHeight - tooltip_el.offsetHeight)) + "px";
}

// Plot creation waits until the container has been laid out and has a real
// width: an end-of-body script (and even the first animation frame, in
// headless browsers) can run while chart_el.clientWidth is still 0. The
// ResizeObserver fires once layout assigns a size, and again on any resize.
let plot = null;
let shown_series = null;
chart_el.style.position = "relative";

function create_plot() {
	plot = make_plot(shown_series);
	shown_series = plot.series.slice(1).map((s) => s.show);
	chart_el.appendChild(tooltip_el);
}

// Rebuild with current data and toggles; used on theme change, and by pages
// whose data layout depends on which series are visible (stacking).
function rebuild_plot() {
	shown_series = plot.series.slice(1).map((s) => s.show);
	plot.destroy();
	create_plot();
	apply_cursor_override();
}

function start_chart() {
	new ResizeObserver(() => {
		const width = chart_el.clientWidth;
		if (width === 0) {
			return;
		}
		if (plot === null) {
			create_plot();
			apply_hide_override();
		} else {
			plot.setSize({ width, height: plot.height });
		}
		apply_cursor_override();
	}).observe(chart_el);

	matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
		if (plot !== null) {
			rebuild_plot();
		}
	});
}

// ?hide=N[,M...] hides series (0-based) through the same setSeries path a
// legend click uses, so toggle behavior can be exercised in a headless
// screenshot.
function apply_hide_override() {
	const hide = new URLSearchParams(location.search).get("hide");
	if (hide === null) {
		return;
	}
	for (const s of hide.split(",")) {
		plot.setSeries(Number(s) + 1, { show: false });
	}
}

// ?cursor=N pins the cursor to version index N, so the tooltip can be
// inspected in a headless screenshot. Re-applied after each (re)layout,
// because a plot created or resized before layout settles cannot map a
// timestamp to a pixel position yet.
const cursor_override = new URLSearchParams(location.search).get("cursor");
function apply_cursor_override() {
	if (cursor_override === null || plot === null) {
		return;
	}
	const idx = Number(cursor_override);
	const pos = plot.valToPos(DATA.timestamps[idx], "x");
	if (pos !== null) {
		plot.setCursor({ left: pos, top: 120 });
	}
}`;

/**
 * @returns uPlot's minified IIFE bundle and stylesheet, read from node_modules
 */
export async function read_uplot(): Promise<{ js: string, css: string }> {
	return {
		js:  await readFile(UPLOT_JS, "utf8"),
		css: await readFile(UPLOT_CSS, "utf8"),
	};
}

/**
 * Render a complete self-contained chart page.
 * @param page page-specific content and scripts
 * @returns the HTML document
 */
export async function render_chart_page(page: ChartPage): Promise<string> {
	const uplot = await read_uplot();
	// "<" must not appear in inline <script> content (it could open "</script>").
	const data_json = JSON.stringify(page.data).replaceAll("<", "\\u003c");
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<style>
${uplot.css}
:root {${THEME_TOKENS_LIGHT}
}
@media (prefers-color-scheme: dark) {
	:root:where(:not([data-theme="light"])) {${THEME_TOKENS_DARK}
	}
}
:root[data-theme="dark"] {${THEME_TOKENS_DARK}
}
${PAGE_CSS}
</style>
<script>
${uplot.js}
</script>
</head>
<body>
<main>
<h1>${page.title}</h1>
<p class="subtitle">${page.subtitle_html}</p>
<div class="chart-card">
	<div id="chart"></div>
	<p class="legend-hint">Click a legend entry to hide or show its series.</p>
</div>
<details class="table-view">
	<summary>Data table (MB)</summary>
	<div class="table-scroll"><table id="data-table"></table></div>
</details>
<footer>${page.footer_html}</footer>
</main>
<script>
const DATA = ${data_json};
${HELPERS_JS}
${page.client_js}
start_chart();
{
	const table_el = document.getElementById("data-table");
${page.table_js}
}
</script>
</body>
</html>
`;
}
