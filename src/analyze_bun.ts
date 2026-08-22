// Model-output: Claude Fable 5

// Breaks each linux-x64 `claude` binary into size components and writes one
// JSONL row per version. The binary is a Bun single-file executable: an ELF
// with the Bun/JavaScriptCore runtime plus an embedded "standalone module
// graph" holding the app's JS, precompiled JSC bytecode, and asset files.
// Format reference: bun's src/standalone_graph/StandaloneModuleGraph.rs.

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const INPUT_JSONL  = "data/vsix_sizes.jsonl";
const OUTPUT_JSONL = "data/bun_composition.jsonl";
const VSIX_DIR     = "vsix";
const PLATFORM     = "linux-x64";
const BINARY_ENTRY = "extension/resources/native-binary/claude";

const TRAILER = Buffer.from("\n---- Bun! ----\n");

const log = getLogger(["analyze"]);
const exec_file = promisify(execFile);

/** One row of data/vsix_sizes.jsonl, as written by process_vsix.ts. */
interface VsixRow {
	vsix_file: string;
	platform: string;
	version: string;
	release_date: string;
	claude_size: number | null;
}

/** One embedded file in the Bun standalone module graph. */
interface GraphModule {
	/** Virtual path, e.g. "/$bunfs/root/cli". */
	name: string;
	/** Size of the file contents, in bytes. */
	contents: number;
	/** Size of the precompiled JSC bytecode for this module, in bytes. */
	bytecode: number;
}

/** Byte sizes of the binary's components; they sum to file_size. */
interface CompositionRow {
	version: string;
	platform: string;
	release_date: string;
	file_size: number;
	/** Bun/JavaScriptCore runtime: everything outside the module graph. */
	runtime: number;
	/** Precompiled JSC bytecode, across all modules. */
	bytecode: number;
	/** Minified JS source of the entrypoint bundle. */
	js_bundle: number;
	/** Native .node addons (ripgrep, image-processor, clipboard, ...). */
	native_addons: number;
	/** Other embedded files (vendored JS libraries, HTML templates, shims). */
	vendored_assets: number;
	/** Graph bookkeeping: names, module table, and anything uncategorized. */
	other: number;
}

/**
 * Locate the Bun standalone module graph inside the binary. Since bun 2025
 * builds the graph lives in a `.bun` ELF section (with the trailer at the
 * section's end); older builds have no section table and append the graph to
 * the file, with a trailing total-size u64 after the trailer.
 * @param binary the whole executable
 * @returns the graph slice (trailer included) and its offset in the binary
 */
function find_graph(binary: Buffer): { graph: Buffer, offset: number } {
	A.eq(binary.readUInt32LE(0), 0x464c457f, "not an ELF file");
	const sh_off      = Number(binary.readBigUInt64LE(0x28));
	const sh_ent_size = binary.readUInt16LE(0x3a);
	const sh_num      = binary.readUInt16LE(0x3c);
	const sh_str_ndx  = binary.readUInt16LE(0x3e);
	for (let i = 0; i < sh_num; i++) {
		const header    = sh_off + i * sh_ent_size;
		const name_off  = binary.readUInt32LE(header);
		const offset    = Number(binary.readBigUInt64LE(header + 0x18));
		const size      = Number(binary.readBigUInt64LE(header + 0x20));
		const strtab    = sh_off + sh_str_ndx * sh_ent_size;
		const names_off = Number(binary.readBigUInt64LE(strtab + 0x18));
		const name_end  = binary.indexOf(0, names_off + name_off);
		if (binary.toString("utf8", names_off + name_off, name_end) === ".bun") {
			return { graph: binary.subarray(offset, offset + size), offset };
		}
	}
	// Old appended-graph format: [runtime ELF][graph][Offsets][trailer]
	// [total_byte_count: u64] at EOF. The graph proper is the byte_count bytes
	// before the Offsets struct.
	const magic_at = binary.lastIndexOf(TRAILER, binary.length - 1);
	A.gte(magic_at, 0, "no .bun section and no Bun trailer at end of file");
	A.gte(magic_at, binary.length - 64, "Bun trailer not near end of file");
	const total = Number(binary.readBigUInt64LE(magic_at + TRAILER.length));
	A.eq(total, binary.length, "trailing total_byte_count does not match file size");
	const byte_count = Number(binary.readBigUInt64LE(magic_at - 32));
	const start = magic_at - 32 - byte_count;
	A.gte(start, 0, "graph byte_count larger than file");
	const graph = binary.subarray(start, magic_at + TRAILER.length);
	return { graph, offset: start };
}

/**
 * Parse the module table out of a graph slice. The trailer-preceding Offsets
 * struct is stable across bun versions, but the per-module struct grew from 4
 * to 6 StringPointers; the right entry size is detected by checking that
 * every name decodes to a "/$bunfs/" path.
 * @param graph graph slice ending with the trailer
 * @returns modules plus which one is the entrypoint
 */
function parse_graph(graph: Buffer): { modules: GraphModule[], entry_point_id: number, byte_count: number } {
	A(graph.subarray(graph.length - TRAILER.length).equals(TRAILER), "graph does not end with Bun trailer");
	const offsets        = graph.length - TRAILER.length - 32;
	const byte_count     = Number(graph.readBigUInt64LE(offsets));
	const mod_off        = graph.readUInt32LE(offsets + 8);
	const mod_len        = graph.readUInt32LE(offsets + 12);
	const entry_point_id = graph.readUInt32LE(offsets + 16);
	const base           = offsets - byte_count;
	A.gte(base, 0, "graph byte_count larger than graph slice");

	// Entry layouts: N StringPointers {off: u32, len: u32} then 4 enum bytes.
	for (const pointer_count of [6, 4]) {
		const entry_size = pointer_count * 8 + 4;
		if (mod_len % entry_size !== 0) {
			continue;
		}
		const modules: GraphModule[] = [];
		for (let i = 0; i < mod_len / entry_size; i++) {
			const entry    = base + mod_off + i * entry_size;
			const name_off = graph.readUInt32LE(entry);
			const name_len = graph.readUInt32LE(entry + 4);
			const name     = graph.toString("utf8", base + name_off, base + name_off + name_len);
			if (!name.startsWith("/$bunfs/")) {
				modules.length = 0;
				break;
			}
			modules.push({
				name,
				contents: graph.readUInt32LE(entry + 12),
				bytecode: graph.readUInt32LE(entry + 28),
			});
		}
		if (modules.length > 0) {
			A.lt(entry_point_id, modules.length, "entry_point_id out of range");
			return { modules, entry_point_id, byte_count };
		}
	}
	throw new Error("could not detect module entry size");
}

/**
 * Categorize a binary's bytes into the composition buckets.
 * @param binary the whole executable
 * @param row metadata for the version being analyzed
 * @returns component sizes summing exactly to the binary size
 */
function analyze_binary(binary: Buffer, row: VsixRow): CompositionRow {
	const { graph } = find_graph(binary);
	const { modules, entry_point_id, byte_count } = parse_graph(graph);
	let bytecode        = 0;
	let js_bundle       = 0;
	let native_addons   = 0;
	let vendored_assets = 0;
	for (const [i, module] of modules.entries()) {
		bytecode += module.bytecode;
		if (i === entry_point_id) {
			js_bundle += module.contents;
		} else if (module.name.endsWith(".node")) {
			native_addons += module.contents;
		} else {
			vendored_assets += module.contents;
		}
	}
	A.gt(js_bundle, 1_000_000, () => `${row.version}: suspiciously small entrypoint bundle (${js_bundle} bytes)`);
	const runtime = binary.length - graph.length;
	const other   = binary.length - runtime - bytecode - js_bundle - native_addons - vendored_assets;
	A.gte(other, 0, () => `${row.version}: negative 'other' bucket`);
	A.lte(other, byte_count, () => `${row.version}: 'other' bucket exceeds graph size`);
	return {
		version:      row.version,
		platform:     row.platform,
		release_date: row.release_date,
		file_size:    binary.length,
		runtime,
		bytecode,
		js_bundle,
		native_addons,
		vendored_assets,
		other,
	};
}

/**
 * Extract the claude binary from one .vsix into memory.
 * @param vsix_file filename under vsix/
 * @returns the executable bytes
 */
async function extract_binary(vsix_file: string): Promise<Buffer> {
	const { stdout } = await exec_file("unzip", ["-p", `${VSIX_DIR}/${vsix_file}`, BINARY_ENTRY], {
		encoding:  "buffer",
		maxBuffer: 1024 * 1024 * 1024,
	});
	A.gt(stdout.length, 0, () => `${vsix_file}: empty ${BINARY_ENTRY}`);
	return stdout;
}

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "analyze",           sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
		],
	});
	const jsonl = await readFile(INPUT_JSONL, "utf8");
	const rows  = jsonl.trimEnd().split("\n")
		.map((line) => JSON.parse(line) as VsixRow)
		.filter((row) => row.platform === PLATFORM && row.claude_size !== null);
	A.gt(rows.length, 0, () => `no ${PLATFORM} rows with a claude binary in ${INPUT_JSONL}`);
	log.info(`analyzing ${rows.length} ${PLATFORM} binaries`);

	const results: CompositionRow[] = [];
	let next_index = 0;
	const worker = async () => {
		while (true) {
			const index = next_index++;
			if (index >= rows.length) {
				return;
			}
			const row    = rows[index]!;
			const binary = await extract_binary(row.vsix_file);
			A.eq(binary.length, row.claude_size!, () => `${row.vsix_file}: extracted size differs from ${INPUT_JSONL}`);
			results.push(analyze_binary(binary, row));
			if (results.length % 25 === 0) {
				log.info(`[${results.length}/${rows.length}] analyzed`);
			}
		}
	};
	await Promise.all(Array.from({ length: 4 }, worker));

	results.sort((a, b) => (Date.parse(a.release_date) - Date.parse(b.release_date)) || a.version.localeCompare(b.version));
	await writeFile(OUTPUT_JSONL, results.map((r) => `${JSON.stringify(r)}\n`).join(""));
	log.info(`wrote ${results.length} rows to ${OUTPUT_JSONL}`);
}

await main();
