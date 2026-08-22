// Model-output: Claude Fable 5

// Reads every downloaded .vsix and emits one JSONL row per package with the
// sizes of the archive, the bundled extension.js, and the bundled `claude`
// binary (absent in platform-neutral "universal" packages). Release dates are
// joined from the marketplace metadata snapshot in data/versions.json.

import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const VSIX_DIR      = "vsix";
const VERSIONS_JSON = "data/versions.json";
const OUTPUT_JSONL  = "data/vsix_sizes.jsonl";

const EXTENSION_JS_ENTRY = "extension/extension.js";
const CLAUDE_ENTRIES     = [
	"extension/resources/native-binary/claude",
	"extension/resources/native-binary/claude.exe",
];

const log = getLogger(["process"]);

/** One package in the data/versions.json snapshot written by download_vsix.ts. */
interface VsixPackage {
	version: string;
	platform: string;
	last_updated: string;
	vsix_url: string;
}

/** One output row describing a single .vsix on disk. */
interface VsixRow {
	/** Filename under vsix/, e.g. "2.1.239-linux-x64.vsix". */
	vsix_file: string;
	/** Target platform, e.g. "linux-x64"; "universal" for platform-neutral packages. */
	platform: string;
	/** Extension version, e.g. "2.1.239". */
	version: string;
	/** ISO timestamp at which the marketplace last updated this package. */
	release_date: string;
	/** Size of the .vsix file itself, in bytes. */
	vsix_size: number;
	/** Uncompressed size of extension/extension.js, in bytes. */
	extension_js_size: number;
	/** Uncompressed size of the bundled claude binary, in bytes; null if not bundled. */
	claude_size: number | null;
}

/**
 * Read a zip's central directory and return the uncompressed size of each
 * entry. Only the archive tail is read, never the file contents. ZIP64
 * archives are rejected by assertion; no .vsix observed so far needs them.
 * @param path zip file path
 * @param file_size size of the zip in bytes, from stat
 * @returns map of entry name to uncompressed size in bytes
 */
async function read_zip_entry_sizes(path: string, file_size: number): Promise<Map<string, number>> {
	const handle = await open(path, "r");
	try {
		const eocd = await find_end_of_central_directory(handle, path, file_size);
		const entry_count = eocd.readUInt16LE(6);
		const cd_size     = eocd.readUInt32LE(8);
		const cd_offset   = eocd.readUInt32LE(12);
		A(entry_count !== 0xffff && cd_offset !== 0xffffffff, () => `${path}: ZIP64 archives are not supported`);

		const cd = Buffer.alloc(cd_size);
		await handle.read(cd, 0, cd_size, cd_offset);
		const sizes = new Map<string, number>();
		let pos = 0;
		for (let i = 0; i < entry_count; i++) {
			A.eq(cd.readUInt32LE(pos), 0x02014b50, () => `${path}: bad central directory entry signature at ${pos}`);
			const uncompressed_size = cd.readUInt32LE(pos + 24);
			const name_length       = cd.readUInt16LE(pos + 28);
			const extra_length      = cd.readUInt16LE(pos + 30);
			const comment_length    = cd.readUInt16LE(pos + 32);
			A(uncompressed_size !== 0xffffffff, () => `${path}: ZIP64 entry sizes are not supported`);
			const name = cd.toString("utf8", pos + 46, pos + 46 + name_length);
			sizes.set(name, uncompressed_size);
			pos += 46 + name_length + extra_length + comment_length;
		}
		A.eq(pos, cd_size, () => `${path}: central directory has trailing bytes`);
		return sizes;
	} finally {
		await handle.close();
	}
}

/**
 * Locate the end-of-central-directory record by scanning backward through the
 * archive tail for its signature.
 * @param handle open handle to the zip
 * @param path zip file path, for error messages
 * @param file_size size of the zip in bytes
 * @returns buffer positioned at the start of the EOCD record's fields (after
 *   the 4-byte signature)
 */
async function find_end_of_central_directory(handle: FileHandle, path: string, file_size: number): Promise<Buffer> {
	// The EOCD record is 22 bytes plus a comment of up to 65535 bytes.
	const tail_size = Math.min(file_size, 22 + 0xffff);
	const tail = Buffer.alloc(tail_size);
	await handle.read(tail, 0, tail_size, file_size - tail_size);
	for (let pos = tail_size - 22; pos >= 0; pos--) {
		if (tail.readUInt32LE(pos) === 0x06054b50) {
			// The signature bytes can also appear inside the archive comment; a
			// real EOCD's declared comment length reaches exactly the file end.
			const comment_length = tail.readUInt16LE(pos + 20);
			if (pos + 22 + comment_length === tail_size) {
				return tail.subarray(pos + 4);
			}
		}
	}
	throw new Error(`${path}: no end-of-central-directory record found`);
}

/**
 * Build one output row for a .vsix on disk.
 * @param vsix_file filename under vsix/, e.g. "2.1.239-linux-x64.vsix"
 * @param packages_by_key marketplace metadata keyed by "version-platform"
 * @returns the row describing this package
 */
async function process_vsix(vsix_file: string, packages_by_key: Map<string, VsixPackage>): Promise<VsixRow> {
	const key = vsix_file.replace(/\.vsix$/, "");
	const pkg = packages_by_key.get(key);
	A(pkg !== undefined, () => `${vsix_file} has no entry in ${VERSIONS_JSON}; rerun the download script to refresh metadata`);

	const path      = `${VSIX_DIR}/${vsix_file}`;
	const vsix_size = (await stat(path)).size;
	const sizes     = await read_zip_entry_sizes(path, vsix_size);

	const extension_js_size = sizes.get(EXTENSION_JS_ENTRY);
	A(extension_js_size !== undefined, () => `${vsix_file}: no ${EXTENSION_JS_ENTRY} entry`);
	const claude_sizes = CLAUDE_ENTRIES.map((entry) => sizes.get(entry)).filter((size) => size !== undefined);
	A.lte(claude_sizes.length, 1, () => `${vsix_file}: multiple claude binaries`);

	return {
		vsix_file,
		platform:          pkg.platform,
		version:           pkg.version,
		release_date:      pkg.last_updated,
		vsix_size,
		extension_js_size,
		claude_size:       claude_sizes[0] ?? null,
	};
}

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "process",           sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
		],
	});

	const packages = JSON.parse(await readFile(VERSIONS_JSON, "utf8")) as VsixPackage[];
	const packages_by_key = new Map(packages.map((p) => [`${p.version}-${p.platform}`, p]));
	A.eq(packages_by_key.size, packages.length, () => `duplicate version-platform keys in ${VERSIONS_JSON}`);

	const vsix_files = (await readdir(VSIX_DIR)).filter((name) => name.endsWith(".vsix"));
	A.gt(vsix_files.length, 0, () => `no .vsix files in ${VSIX_DIR}/`);
	if (vsix_files.length < packages.length) {
		log.warn(`${VERSIONS_JSON} lists ${packages.length} packages but only ${vsix_files.length} are on disk`);
	}

	const rows: VsixRow[] = [];
	for (const vsix_file of vsix_files) {
		rows.push(await process_vsix(vsix_file, packages_by_key));
	}
	// Marketplace timestamps have variable-width fractional seconds (".1Z" vs
	// ".14Z"), so lexical order is not chronological; compare parsed times.
	rows.sort((a, b) => (Date.parse(a.release_date) - Date.parse(b.release_date)) || a.vsix_file.localeCompare(b.vsix_file));

	const jsonl = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
	await writeFile(OUTPUT_JSONL, jsonl);
	const with_claude = rows.filter((row) => row.claude_size !== null).length;
	log.info(`wrote ${rows.length} rows to ${OUTPUT_JSONL} (${with_claude} with a claude binary)`);
}

await main();
