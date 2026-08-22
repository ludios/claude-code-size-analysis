// Model-output: Claude Fable 5

// Downloads every published version of the anthropic.claude-code VS Code
// extension (one .vsix per version and target platform) so that the size of
// the bundled `claude` binary can be studied over time.

import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const GALLERY_QUERY_URL = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";
const EXTENSION_NAME    = "anthropic.claude-code";
const VSIX_ASSET_TYPE   = "Microsoft.VisualStudio.Services.VSIXPackage";
// IncludeVersions | IncludeFiles | IncludeVersionProperties | ExcludeNonValidated
const QUERY_FLAGS       = 0x1 | 0x2 | 0x10 | 0x20;

const log = getLogger(["download"]);

/** One file attached to a version entry in the gallery API response. */
interface GalleryFile {
	assetType: string;
	source: string;
}

/** One (version, target platform) entry in the gallery API response. */
interface GalleryVersion {
	version: string;
	/** Absent on platform-neutral packages. */
	targetPlatform?: string;
	lastUpdated: string;
	files: GalleryFile[];
}

/** One .vsix we intend to have on disk. */
interface VsixPackage {
	/** Extension version, e.g. "2.1.239". */
	version: string;
	/** Target platform, e.g. "linux-x64"; "universal" for platform-neutral packages. */
	platform: string;
	/** ISO timestamp at which the marketplace says this package was last updated. */
	last_updated: string;
	/** Direct CDN URL of the .vsix. */
	vsix_url: string;
}

/**
 * Ask the marketplace gallery API for every version of the extension. All
 * versions arrive in a single response; the API does not page them (observed
 * with ~1900 entries).
 * @returns raw version entries, one per (version, target platform)
 */
async function query_marketplace(): Promise<GalleryVersion[]> {
	const body = {
		filters: [{ criteria: [{ filterType: 7, value: EXTENSION_NAME }] }],
		flags:   QUERY_FLAGS,
	};
	const response = await fetch(GALLERY_QUERY_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Accept":       "application/json;api-version=7.2-preview.1",
		},
		body: JSON.stringify(body),
	});
	A.eq(response.status, 200, () => `gallery query returned ${response.status}`);
	const data = await response.json() as { results: { extensions: { versions: GalleryVersion[] }[] }[] };
	const extensions = data.results[0]?.extensions;
	A(extensions !== undefined && extensions.length === 1, () => `expected exactly one extension for ${EXTENSION_NAME}`);
	const versions = extensions[0]!.versions;
	A.gt(versions.length, 0);
	return versions;
}

/**
 * Convert raw gallery entries into download targets, asserting that each entry
 * has exactly one .vsix asset and that (version, platform) pairs are unique.
 * @param versions raw version entries from the gallery API
 * @returns download targets, oldest first by marketplace update time
 */
function build_package_list(versions: GalleryVersion[]): VsixPackage[] {
	const seen = new Set<string>();
	const packages = versions.map((v) => {
		const platform = v.targetPlatform ?? "universal";
		const key = `${v.version}-${platform}`;
		A(!seen.has(key), () => `duplicate package ${key}`);
		seen.add(key);
		const vsix_files = v.files.filter((f) => f.assetType === VSIX_ASSET_TYPE);
		A.eq(vsix_files.length, 1, () => `expected one VSIXPackage asset for ${key}`);
		return {
			version:      v.version,
			platform,
			last_updated: v.lastUpdated,
			vsix_url:     vsix_files[0]!.source,
		};
	});
	packages.sort((a, b) => a.last_updated.localeCompare(b.last_updated));
	return packages;
}

/**
 * @param path file path to test
 * @returns whether something exists at `path`
 */
async function file_exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Download one .vsix to `${dest_dir}/${version}-${platform}.vsix` unless that
 * file already exists. The body is written to a .part path and renamed only
 * after it fully arrives, so a final file that exists is always complete and
 * an interrupted run can be resumed by rerunning the program.
 * @param pkg download target
 * @param dest_dir directory to place the file in
 * @returns "downloaded", or "skipped" if the file was already present
 */
async function download_package(pkg: VsixPackage, dest_dir: string): Promise<"downloaded" | "skipped"> {
	const dest = `${dest_dir}/${pkg.version}-${pkg.platform}.vsix`;
	if (await file_exists(dest)) {
		return "skipped";
	}
	const response = await fetch(pkg.vsix_url);
	A.eq(response.status, 200, () => `GET ${pkg.vsix_url} returned ${response.status}`);
	A(response.body !== null);
	const part = `${dest}.part`;
	await pipeline(Readable.fromWeb(response.body), createWriteStream(part));
	const expected_length = response.headers.get("content-length");
	if (expected_length !== null) {
		const actual_length = (await stat(part)).size;
		A.eq(actual_length, Number(expected_length), () => `truncated download for ${dest}`);
	}
	await rename(part, dest);
	return "downloaded";
}

/**
 * Run `fn`, retrying on failure with increasing delays.
 * @param fn action to attempt
 * @param what description of the action, for log messages
 * @returns the value of the first successful attempt
 */
async function with_retries<T>(fn: () => Promise<T>, what: string): Promise<T> {
	const delays_ms = [2_000, 10_000, 30_000];
	for (let attempt = 0; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= delays_ms.length) {
				throw error;
			}
			log.warn(`${what} failed (attempt ${attempt + 1}), retrying: {error}`, { error });
			await sleep(delays_ms[attempt]);
		}
	}
}

/**
 * Download every package using a fixed number of concurrent workers. A package
 * whose retries are exhausted is recorded rather than aborting the run, so one
 * bad URL cannot stop the other ~1900 downloads.
 * @param packages download targets
 * @param dest_dir directory to place files in
 * @param concurrency number of simultaneous downloads
 * @returns names of packages that could not be downloaded
 */
async function download_all(packages: VsixPackage[], dest_dir: string, concurrency: number): Promise<string[]> {
	A.gt(concurrency, 0);
	let next_index = 0;
	let done       = 0;
	let skipped    = 0;
	const failed: string[] = [];
	const worker = async () => {
		while (true) {
			const index = next_index++;
			if (index >= packages.length) {
				return;
			}
			const pkg  = packages[index]!;
			const name = `${pkg.version}-${pkg.platform}`;
			try {
				const outcome = await with_retries(() => download_package(pkg, dest_dir), name);
				done++;
				if (outcome === "skipped") {
					skipped++;
				} else {
					log.info(`[${done}/${packages.length}] ${name}`);
				}
			} catch (error) {
				done++;
				failed.push(name);
				log.error(`giving up on ${name}: {error}`, { error });
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	log.info(`finished: ${done - skipped - failed.length} downloaded, ${skipped} already present, ${failed.length} failed`);
	return failed;
}

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "download",           sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"],  sinks: ["console"], lowestLevel: "warning" },
		],
	});
	const dest_dir = "vsix";
	await mkdir(dest_dir, { recursive: true });
	await mkdir("data",   { recursive: true });

	const versions = await query_marketplace();
	const packages = build_package_list(versions);
	const unique_versions = new Set(packages.map((p) => p.version)).size;
	log.info(`marketplace lists ${packages.length} packages across ${unique_versions} versions`);
	// Snapshot the metadata (including marketplace timestamps) next to the
	// downloads; later analysis joins binary sizes against these dates.
	await writeFile("data/versions.json", `${JSON.stringify(packages, null, "\t")}\n`);

	const failed = await download_all(packages, dest_dir, 4);
	if (failed.length > 0) {
		log.error(`failed packages: ${failed.join(", ")}`);
		process.exitCode = 1;
	}
}

await main();
