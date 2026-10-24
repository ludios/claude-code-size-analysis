// Model-output: Claude Fable 5
// Model-output: Claude Opus 5.5

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

/** A byte range relative to the graph's base, the start of its byte_count
 * bytes (bun's StringPointer). */
interface StringPointer {
	offset: number;
	length: number;
}

/** One embedded file in the Bun standalone module graph. */
interface GraphModule {
	/** Virtual path, e.g. "/$bunfs/root/cli". */
	name: string;
	/** Size of the file contents, in bytes. */
	contents: number;
	/** The module's precompiled JSC bytecode; length 0 if it has none. In a
	 * linked-payload graph this runs from the module's cache entry to the end
	 * of the shared payload, so different modules' ranges overlap. */
	bytecode: StringPointer;
}

/** Byte sizes of the binary's components; they sum to file_size. */
interface CompositionRow {
	version: string;
	platform: string;
	release_date: string;
	file_size: number;
	/** Bun/JavaScriptCore runtime: everything outside the module graph. */
	runtime: number;
	/** Precompiled JSC bytecode: per-module and builtin-module payloads (or,
	 * in builds with a linked payload, 2.1.310+, the one payload they all
	 * share) plus, when present, the shared bytecode string table. */
	bytecode: number;
	/** Minified JS source of the app bundle: the entrypoint plus, since the
	 * code-split builds of 2.1.243+, every chunk compiled to bytecode. */
	js_bundle: number;
	/** Native .node addons (ripgrep, image-processor, clipboard, ...). */
	native_addons: number;
	/** Other embedded files (vendored JS libraries, HTML templates, shims). */
	vendored_assets: number;
	/** Graph bookkeeping: names, module table, per-module module_info
	 * metadata and its string table, the prelinked module graph, and anything
	 * uncategorized. */
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

// Offsets.flags bits (bun's StandaloneModuleGraph) gating optional records
// that follow the module table; the records appear in this bit order. Bits
// 0-4 and 10 are plain build options without a record.
const HAS_SOURCE_HASHES            = 1 << 5;
const HAS_BUILTIN_BYTECODE         = 1 << 6;
const HAS_BYTECODE_STRING_TABLE    = 1 << 7;
const HAS_STARTUP_MODULE_COUNT     = 1 << 8;
const HAS_MODULE_INFO_STRING_TABLE = 1 << 9;
const HAS_PRELINKED_MODULE_GRAPH   = 1 << 11;
const HAS_RUNTIME_OPTIONS          = 1 << 12;
const HAS_LINKED_BYTECODE_PAYLOAD  = 1 << 13;
const KNOWN_FLAGS_END              = 1 << 14;
/** Region-end u32s in the linked-payload record (bun's LINKED_BYTECODE_REGION_COUNT). */
const LINKED_BYTECODE_REGION_COUNT = 6;

/**
 * Total the graph's JSC bytecode by walking the flag-gated records after the
 * module table. Without a linked payload, every module and builtin module
 * has its own disjoint bytecode; with one (an opt-in bun build option, seen
 * since 2.1.310), all of them are cache entries into a single shared payload,
 * which is counted once.
 * @param read_u32 reads a u32 at an offset relative to the graph's base
 * @param records_at offset of the first record, just past the module table
 * @param records_end offset where the records must end (the compile_exec_argv
 *        string, which bun writes right after them)
 * @param flags the Offsets.flags word
 * @param modules the parsed module table
 * @returns bytecode bytes, including the shared bytecode string table
 */
function count_bytecode(read_u32: (offset: number) => number, records_at: number, records_end: number, flags: number, modules: GraphModule[]): number {
	A.lt(flags, KNOWN_FLAGS_END, "unknown Offsets.flags bits; the graph format changed");
	const read_pointer = (offset: number): StringPointer => ({ offset: read_u32(offset), length: read_u32(offset + 4) });
	let pos = records_at;
	const entries      = modules.map((module) => module.bytecode);
	let   string_table = 0;
	let   payload: StringPointer | null = null;
	if (flags & HAS_SOURCE_HASHES) {
		pos += 4 * modules.length;
	}
	if (flags & HAS_BUILTIN_BYTECODE) {
		const count = read_u32(pos);
		pos += 4;
		for (let i = 0; i < count; i++) {
			// { u32 InternalModuleRegistry id, StringPointer bytecode }
			entries.push(read_pointer(pos + 4));
			pos += 12;
		}
	}
	if (flags & HAS_BYTECODE_STRING_TABLE) {
		string_table = read_pointer(pos).length;
		pos += 8;
	}
	if (flags & HAS_STARTUP_MODULE_COUNT) {
		pos += 4;
	}
	if (flags & HAS_MODULE_INFO_STRING_TABLE) {
		pos += 8;
	}
	if (flags & HAS_PRELINKED_MODULE_GRAPH) {
		pos += 8;
		pos += 4 + 4 * read_u32(pos);
	}
	if (flags & HAS_RUNTIME_OPTIONS) {
		pos += 8;
	}
	if (flags & HAS_LINKED_BYTECODE_PAYLOAD) {
		payload = read_pointer(pos);
		pos += 8 + 4 * LINKED_BYTECODE_REGION_COUNT;
		A.eq(read_u32(pos - 4), payload.length, "last linked-payload region does not end at the payload's end");
	}
	A.eq(pos, records_end, "flag-gated records do not end where compile_exec_argv begins");

	const used = entries.filter((entry) => entry.length > 0);
	if (payload === null) {
		return used.reduce((sum, entry) => sum + entry.length, string_table);
	}
	const payload_end = payload.offset + payload.length;
	for (const entry of used) {
		A.gte(entry.offset, payload.offset, "bytecode entry before the linked payload");
		A.eq(entry.offset + entry.length, payload_end, "bytecode entry does not run to the end of the linked payload");
	}
	return payload.length + string_table;
}

/**
 * Parse the module table out of a graph slice. The trailer-preceding Offsets
 * struct is stable across bun versions, but the per-module struct grew from 4
 * to 6 StringPointers; the right entry size is detected by checking that
 * every name decodes to a "/$bunfs/" path.
 * @param graph graph slice ending with the trailer
 * @returns modules, which one is the entrypoint, the graph's byte_count, and
 *          bytecode: total bytes of JSC bytecode in the graph
 */
function parse_graph(graph: Buffer): { modules: GraphModule[], entry_point_id: number, byte_count: number, bytecode: number } {
	A(graph.subarray(graph.length - TRAILER.length).equals(TRAILER), "graph does not end with Bun trailer");
	const offsets        = graph.length - TRAILER.length - 32;
	const byte_count     = Number(graph.readBigUInt64LE(offsets));
	const mod_off        = graph.readUInt32LE(offsets + 8);
	const mod_len        = graph.readUInt32LE(offsets + 12);
	const entry_point_id = graph.readUInt32LE(offsets + 16);
	const exec_argv_off  = graph.readUInt32LE(offsets + 20);
	const flags          = graph.readUInt32LE(offsets + 28);
	const base           = offsets - byte_count;
	A.gte(base, 0, "graph byte_count larger than graph slice");
	const read_u32 = (offset: number) => graph.readUInt32LE(base + offset);

	// Entry layouts: N StringPointers {off: u32, len: u32} then 4 enum bytes.
	for (const pointer_count of [6, 4]) {
		const entry_size = pointer_count * 8 + 4;
		if (mod_len % entry_size !== 0) {
			continue;
		}
		const modules: GraphModule[] = [];
		for (let i = 0; i < mod_len / entry_size; i++) {
			const entry    = mod_off + i * entry_size;
			const name_off = read_u32(entry);
			const name_len = read_u32(entry + 4);
			const name     = graph.toString("utf8", base + name_off, base + name_off + name_len);
			if (!name.startsWith("/$bunfs/")) {
				modules.length = 0;
				break;
			}
			modules.push({
				name,
				contents: read_u32(entry + 12),
				bytecode: { offset: read_u32(entry + 24), length: read_u32(entry + 28) },
			});
		}
		if (modules.length > 0) {
			A.lt(entry_point_id, modules.length, "entry_point_id out of range");
			// Only the 6-pointer layout has a meaningful flags word and records.
			const bytecode = pointer_count === 6
				? count_bytecode(read_u32, mod_off + mod_len, exec_argv_off, flags, modules)
				: modules.reduce((sum, module) => sum + module.bytecode.length, 0);
			return { modules, entry_point_id, byte_count, bytecode };
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
	const { modules, entry_point_id, byte_count, bytecode } = parse_graph(graph);
	let js_bundle       = 0;
	let native_addons   = 0;
	let vendored_assets = 0;
	// App code is the entrypoint plus anything precompiled to bytecode: builds
	// through 2.1.241 shipped one big entrypoint bundle (the only module with
	// bytecode), while 2.1.243+ code-split the app into hundreds of chunk
	// modules, each with bytecode (since 2.1.310, a cache entry into one
	// shared payload). Vendored JS served as text
	// (mermaid, hljs, ...) has no bytecode and stays in vendored_assets.
	for (const [i, module] of modules.entries()) {
		if (i === entry_point_id || module.bytecode.length > 0) {
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
 * Load previously analyzed rows so unchanged versions are not re-extracted;
 * analysis is by far the slowest stage of the pipeline.
 * @returns existing rows keyed by version; empty if the output does not exist
 */
async function read_existing_rows(): Promise<Map<string, CompositionRow>> {
	let text: string;
	try {
		text = await readFile(OUTPUT_JSONL, "utf8");
	} catch {
		return new Map();
	}
	const existing = new Map<string, CompositionRow>();
	for (const line of text.trimEnd().split("\n")) {
		const row = JSON.parse(line) as CompositionRow;
		A(!existing.has(row.version), () => `duplicate version ${row.version} in ${OUTPUT_JSONL}`);
		existing.set(row.version, row);
	}
	return existing;
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
	// A version is re-analyzed if its binary size changed; otherwise the
	// existing row's component sizes are kept. Size is a sufficient identity
	// here because the download stage never overwrites a .vsix already on
	// disk, so a version's local binary is immutable. Pass --full to discard
	// the cache (e.g. after changing the analyzer itself).
	const existing = process.argv.includes("--full") ? new Map<string, CompositionRow>() : await read_existing_rows();
	const pending  = rows.filter((row) => existing.get(row.version)?.file_size !== row.claude_size);
	log.info(`analyzing ${pending.length} of ${rows.length} ${PLATFORM} binaries (${rows.length - pending.length} already in ${OUTPUT_JSONL})`);

	const analyzed: CompositionRow[] = [];
	let next_index = 0;
	const worker = async () => {
		while (true) {
			const index = next_index++;
			if (index >= pending.length) {
				return;
			}
			const row    = pending[index]!;
			const binary = await extract_binary(row.vsix_file);
			A.eq(binary.length, row.claude_size!, () => `${row.vsix_file}: extracted size differs from ${INPUT_JSONL}`);
			try {
				analyzed.push(analyze_binary(binary, row));
			} catch (error) {
				throw new Error(`${row.vsix_file}: analysis failed`, { cause: error });
			}
			if (analyzed.length % 25 === 0) {
				log.info(`[${analyzed.length}/${pending.length}] analyzed`);
			}
		}
	};
	await Promise.all(Array.from({ length: 4 }, worker));

	const by_version = new Map([...existing, ...analyzed.map((r) => [r.version, r] as const)]);
	// Metadata always comes from the current input row, so a marketplace
	// timestamp change cannot leave cached rows inconsistent with the other
	// outputs; only the component sizes are reused.
	const results = rows.map((row) => {
		const cached = by_version.get(row.version)!;
		cached.platform     = row.platform;
		cached.release_date = row.release_date;
		return cached;
	});
	results.sort((a, b) => (Date.parse(a.release_date) - Date.parse(b.release_date)) || a.version.localeCompare(b.version));
	await writeFile(OUTPUT_JSONL, results.map((r) => `${JSON.stringify(r)}\n`).join(""));
	log.info(`wrote ${results.length} rows to ${OUTPUT_JSONL} (${analyzed.length} newly analyzed)`);
}

await main();
