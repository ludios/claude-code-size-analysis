// Model-output: Claude Opus 5.5

// Builds one git repository per measured model, prompt-history/<series>/,
// from the requests that measure_context.ts saved: each commit is one
// version's initial context for that model, dated at the version's release
// and tagged with the version, e.g. `git diff 2.1.200 2.1.296`. A version
// that changed nothing still gets its commit. Each commit holds:
//
//   system.md    the system prompt, without the billing metadata block
//   messages.md  the messages: injected context around the typed prompt
//   tools/*.md   each tool's description and input schema
//   params.json  the rest of the request, e.g. model, max_tokens, thinking
//
// The repositories are rebuilt from scratch on every run; their commit IDs
// stay the same as long as the captures and this script do.

import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const INPUT_JSONL = "data/initial_context.jsonl";
const CAPTURE_DIR = "captured_requests";
const OUTPUT_DIR  = "prompt-history";

/** Start of the system block carrying per-request billing metadata rather than prompt text. */
const BILLING_HEADER = "x-anthropic-billing-header:";
/** The scratch directory each session ran in, named differently per capture. */
const SCRATCH_DIR             = /claude-context-[A-Za-z0-9]{6}\b/g;
const SCRATCH_DIR_PLACEHOLDER = "claude-context-XXXXXX";
/** Request keys left out of params.json: the prompt, which has files of its
 * own, and metadata, which holds per-session IDs. */
const OMITTED_PARAMS = new Set(["system", "tools", "messages", "metadata"]);
/** Author and committer of every commit. */
const IDENTITY = "Claude Code <noreply@anthropic.com>";

const log = getLogger(["prompt-history"]);
const exec_file = promisify(execFile);

/** One row of data/initial_context.jsonl, as far as this script reads it. */
interface ContextRow {
	version: string;
	release_date: string;
	/** Series key, e.g. "opus". */
	series: string;
	/** Model ID the version resolved the series to, e.g. "claude-opus-5-5". */
	model: string;
}

interface ContentBlock {
	type: string;
	text?: string;
}

interface Tool {
	name: string;
	description: string;
	input_schema: object;
}

/** A captured Messages API request body. */
interface MessagesBody {
	model: string;
	system?: ContentBlock[];
	tools: Tool[];
	messages: { role: string, content: string | ContentBlock[] }[];
	[param: string]: unknown;
}

/** One commit of a model's history. */
interface Snapshot {
	version: string;
	model: string;
	/** Release time, in seconds since the Unix epoch. */
	time: number;
	/** File contents by path. */
	files: Map<string, string>;
}

/**
 * @param content a system or message content value; a string is one text block
 * @param label for error messages
 * @returns the text of each block
 */
function text_blocks(content: string | ContentBlock[], label: string): string[] {
	if (typeof content === "string") {
		return [content];
	}
	return content.map((block) => {
		A.eq(block.type, "text", () => `${label}: non-text content block`);
		A.eq(typeof block.text, "string", () => `${label}: text block without text`);
		return block.text!;
	});
}

/**
 * @param named texts, each with a name such as "system block 1"
 * @returns the texts one after another, each under an HTML comment with its name
 */
function render_blocks(named: [string, string][]): string {
	return named.map(([name, text]) => `<!-- ${name} -->\n${text.endsWith("\n") ? text : `${text}\n`}`).join("\n");
}

/**
 * @param tool a tool definition from the request
 * @returns markdown: the description, then the input schema as JSON
 */
function render_tool(tool: Tool): string {
	const schema = JSON.stringify(tool.input_schema, null, "\t");
	A(!schema.includes("```"), () => `${tool.name}: input schema contains a code fence`);
	return `${tool.description.trimEnd()}\n\n\`\`\`json\n${schema}\n\`\`\`\n`;
}

/**
 * @param body a captured request
 * @param label for error messages
 * @returns the files of the request's commit, by path
 */
function snapshot_files(body: MessagesBody, label: string): Map<string, string> {
	const files  = new Map<string, string>();
	const system = text_blocks(body.system ?? [], `${label} system`).filter((text) => !text.startsWith(BILLING_HEADER));
	files.set("system.md", render_blocks(system.map((text, i) => [`system block ${i + 1}`, text])));
	files.set("messages.md", render_blocks(body.messages.flatMap((message, m) => {
		const texts = text_blocks(message.content, `${label} message ${m + 1}`);
		return texts.map((text, b): [string, string] => [`message ${m + 1} (${message.role}), block ${b + 1}`, text]);
	})));
	for (const tool of body.tools) {
		// Any other key would be part of the context but missing from the file.
		A.eq(Object.keys(tool).toSorted().join(","), "description,input_schema,name", () => `${label}: tool ${tool.name} has other keys`);
		A(/^[\w-]+$/.test(tool.name), () => `${label}: tool name ${JSON.stringify(tool.name)} does not make a plain filename`);
		const path = `tools/${tool.name}.md`;
		A(!files.has(path), () => `${label}: tool ${tool.name} appears twice`);
		files.set(path, render_tool(tool));
	}
	const params = Object.fromEntries(Object.entries(body).filter(([key]) => !OMITTED_PARAMS.has(key)));
	files.set("params.json", `${JSON.stringify(params, null, "\t")}\n`);
	return files;
}

/**
 * @param row a measured version and series
 * @returns the commit for its captured request
 */
async function read_snapshot(row: ContextRow): Promise<Snapshot> {
	const path = join(CAPTURE_DIR, `${row.version}-${row.series}.json`);
	const raw  = await readFile(path, "utf8");
	const body = JSON.parse(raw.replaceAll(SCRATCH_DIR, SCRATCH_DIR_PLACEHOLDER)) as MessagesBody;
	A.eq(body.model, row.model, () => `${path}: model differs from ${INPUT_JSONL}`);
	const ms = Date.parse(row.release_date);
	A(Number.isFinite(ms), () => `${row.version}: unparsable release date ${row.release_date}`);
	return { version: row.version, model: row.model, time: Math.floor(ms / 1000), files: snapshot_files(body, path) };
}

/**
 * @param data the payload of a fast-import data command
 * @returns the command, with the payload's exact byte count
 */
function data_command(data: string): Buffer {
	const bytes = Buffer.from(data);
	return Buffer.concat([Buffer.from(`data ${bytes.length}\n`), bytes, Buffer.from("\n")]);
}

/**
 * @param snapshots oldest first
 * @returns a git fast-import stream that commits each snapshot as the whole
 * tree of refs/heads/main and tags the commit with its version
 */
function fast_import_stream(snapshots: Snapshot[]): Buffer {
	const chunks: Buffer[] = [];
	snapshots.forEach((snapshot, i) => {
		const mark = i + 1;
		const who  = `${IDENTITY} ${snapshot.time} +0000`;
		chunks.push(Buffer.from(`commit refs/heads/main\nmark :${mark}\nauthor ${who}\ncommitter ${who}\n`));
		chunks.push(data_command(`${snapshot.version} ${snapshot.model}\n`));
		chunks.push(Buffer.from("deleteall\n"));
		for (const [path, content] of snapshot.files) {
			chunks.push(Buffer.from(`M 100644 inline ${path}\n`), data_command(content));
		}
		chunks.push(Buffer.from(`\nreset refs/tags/${snapshot.version}\nfrom :${mark}\n\n`));
	});
	chunks.push(Buffer.from("done\n"));
	return Buffer.concat(chunks);
}

/**
 * Build a model's history repository and put it in place of the previous one.
 * @param dir where the repository goes
 * @param snapshots oldest first
 */
async function build_repo(dir: string, snapshots: Snapshot[]): Promise<void> {
	const building = `${dir}.building`;
	await rm(building, { recursive: true, force: true });
	await exec_file("git", ["init", "--quiet", "--initial-branch=main", building]);
	const importer = spawn("git", ["-C", building, "fast-import", "--quiet", "--done"], { stdio: ["pipe", "inherit", "inherit"] });
	importer.stdin.end(fast_import_stream(snapshots));
	const [code] = await once(importer, "close") as [number | null];
	A.eq(code, 0, () => `git fast-import into ${building} failed`);
	await exec_file("git", ["-C", building, "reset", "--quiet", "--hard"]);

	if (existsSync(dir)) {
		A(existsSync(join(dir, ".git")), () => `${dir} is not a git repository; not replacing it`);
		await rm(dir, { recursive: true });
	}
	await rename(building, dir);
}

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "prompt-history",    sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
		],
	});
	const jsonl = await readFile(INPUT_JSONL, "utf8");
	const rows  = jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as ContextRow);
	A.gt(rows.length, 0, () => `no rows in ${INPUT_JSONL}`);

	await mkdir(OUTPUT_DIR, { recursive: true });
	for (const [series, series_rows] of Map.groupBy(rows, (row) => row.series)) {
		const snapshots: Snapshot[] = [];
		let changes = 0;
		for (const row of series_rows) {
			const snapshot = await read_snapshot(row);
			const previous = snapshots.at(-1);
			if (previous !== undefined) {
				// Rows come in release order, so a repeated version would be adjacent.
				A.neq(previous.version, snapshot.version, () => `${series}: ${row.version} appears twice`);
				A.lte(previous.time, snapshot.time, () => `${series}: ${row.version} is out of release order`);
			}
			if (JSON.stringify([...snapshot.files]) !== JSON.stringify([...previous?.files ?? []])) {
				changes++;
			}
			snapshots.push(snapshot);
		}
		const dir = join(OUTPUT_DIR, series);
		await build_repo(dir, snapshots);
		log.info(`${dir}: ${snapshots.length} versions from ${snapshots[0]!.version} to ${snapshots.at(-1)!.version}, ${changes} of them with changes`);
	}
}

await main();
