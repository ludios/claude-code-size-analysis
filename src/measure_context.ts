// Model-output: Claude Opus 5.5

// Measures the initial context of an interactive `claude` session (system
// prompt, tool definitions, and the context messages injected around the
// first user turn) for each linux-x64 binary and several models. Every
// binary runs in a pseudo-terminal against a local stand-in for the
// Anthropic API; the Messages request carrying the first turn is saved under
// captured_requests/, and the parts of each saved request are measured, in
// UTF-8 bytes, into data/initial_context.jsonl.
//
// Run this through `pnpm run context`, which puts it in private network and
// PID namespaces: the binary can reach nothing but the stand-in, so remote
// feature flags cannot vary the prompt and nothing is sent anywhere; and as
// PID 1, this process takes every session still running down with it.

import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { availableParallelism, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { configure, getConsoleSink, getLogger } from "@logtape/logtape";
import { A } from "ayy";

const INPUT_JSONL  = "data/vsix_sizes.jsonl";
const OUTPUT_JSONL = "data/initial_context.jsonl";
const VSIX_DIR     = "vsix";
const CAPTURE_DIR  = "captured_requests";
const PLATFORM     = "linux-x64";
const BINARY_ENTRY = "extension/resources/native-binary/claude";

/** The first user turn typed into each session; not counted as context. */
const PROMPT  = "hi";
const API_KEY = "sk-ant-api03-placeholder";
/** Start of the system block carrying per-request billing metadata rather than prompt text. */
const BILLING_HEADER = "x-anthropic-billing-header:";

/** The TUI counts as ready for input once its output has been quiet this long. */
const QUIET_MS         = 1500;
const READY_TIMEOUT_MS = 30_000;
/** How long a submitted prompt may take to produce its request. */
const SUBMIT_WAIT_MS   = 10_000;
const SUBMIT_ATTEMPTS  = 3;
const EXIT_TIMEOUT_MS  = 10_000;
const CAPTURE_ATTEMPTS = 3;
/** Versions captured concurrently, one session each; a session holds ~0.3 GB. */
const WORKERS = availableParallelism();

/** One measured model; sessions are launched as `claude --model <model_arg>`. */
interface Series {
	/** Short name used in capture filenames and the chart, e.g. "opus". */
	key: string;
	model_arg: string;
	/** Only binaries containing this string are tried; for full model IDs,
	 * which any version accepts verbatim whether or not it knows the model. */
	requires?: string;
}

// An alias resolves to the version's current model of that family. A version
// that lacks the alias sends it on verbatim, and its capture is skipped.
const SERIES: Series[] = [
	{ key: "opus",           model_arg: "opus" },
	{ key: "fable",          model_arg: "fable" },
	{ key: "mythos-preview", model_arg: "claude-mythos-preview", requires: "claude-mythos-preview" },
	{ key: "sonnet",         model_arg: "sonnet" },
	{ key: "haiku",          model_arg: "haiku" },
];

const log = getLogger(["context"]);
const exec_file = promisify(execFile);

/** One row of data/vsix_sizes.jsonl, as written by process_vsix.ts. */
interface VsixRow {
	vsix_file: string;
	platform: string;
	version: string;
	release_date: string;
	claude_size: number | null;
}

interface ContentBlock {
	type: string;
	text?: string;
}

/** A Messages API request body, as far as this script reads it. */
interface MessagesBody {
	model: string;
	stream?: boolean;
	system?: string | ContentBlock[];
	tools?: { name: string, defer_loading?: boolean }[];
	messages: { role: string, content: string | ContentBlock[] }[];
}

/** Initial context of one version with one model; sizes in UTF-8 bytes. */
interface ContextRow {
	version: string;
	platform: string;
	release_date: string;
	/** Series key, e.g. "opus". */
	series: string;
	/** Model ID the version resolved the series to, e.g. "claude-opus-5-5". */
	model: string;
	/** System prompt text, without the billing metadata block. */
	system: number;
	/** Tool definitions, as the JSON of the request's tools array. */
	tools: number;
	tool_count: number;
	/** Text the session put into the messages besides the typed prompt:
	 * system reminders, environment details, skill and agent listings. */
	messages: number;
	/** system + tools + messages. */
	total: number;
}

/**
 * Check that this process runs in the private network and PID namespaces
 * set up by `pnpm run context`, and bring up loopback.
 */
async function enter_sandbox(): Promise<void> {
	const others = Object.keys(networkInterfaces()).filter((name) => name !== "lo");
	A.eq(others.join(","), "", "network interfaces other than loopback are visible; run this via `pnpm run context`");
	A.eq(process.pid, 1, "not PID 1 of a PID namespace; run this via `pnpm run context`");
	await exec_file("ip", ["link", "set", "lo", "up"]);
}

/**
 * @returns whether the request opens the conversation with the typed prompt:
 *   it has tool definitions (side requests for titles and topics do not), no
 *   assistant turn yet, and exactly one content block that is the prompt
 *   (subagent warmups carry tools too, but not the prompt)
 */
function is_initial_request(body: MessagesBody): boolean {
	const texts = body.messages.flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.map((block) => block.text));
	return (body.tools?.length ?? 0) > 0
		&& body.messages.every((message) => message.role !== "assistant")
		&& texts.filter((text) => text === PROMPT).length === 1;
}

/**
 * Answer a Messages request with an assistant turn saying "ok", streamed
 * when the request asks for it.
 * @param res response to write
 * @param body the parsed request
 */
function write_ok_reply(res: ServerResponse, body: MessagesBody): void {
	const message = {
		id:            "msg_initial_context",
		type:          "message",
		role:          "assistant",
		model:         body.model,
		content:       [],
		stop_reason:   null,
		stop_sequence: null,
		usage:         { input_tokens: 1, output_tokens: 1 },
	};
	if (!body.stream) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ...message, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
		return;
	}
	const events = [
		{ type: "message_start", message },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	res.writeHead(200, { "content-type": "text/event-stream" });
	res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

/**
 * Serve a stand-in for the Anthropic API on an ephemeral loopback port.
 * Every Messages request is answered "ok", so that side requests made before
 * the main one (quota checks, topic detection) complete normally; token
 * counting answers 1, and other endpoints 404.
 * @param on_messages called with the raw and parsed body of each Messages request
 * @returns the listening server and the base URL to give the binary
 */
async function start_mock_api(on_messages: (raw: string, body: MessagesBody) => void): Promise<{ server: Server, base_url: string }> {
	const server = createServer((req, res) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk: string) => {
			raw += chunk;
		});
		req.on("end", () => {
			const path = req.url?.split("?")[0];
			if (req.method === "POST" && path === "/v1/messages/count_tokens") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ input_tokens: 1 }));
				return;
			}
			if (req.method !== "POST" || path !== "/v1/messages") {
				log.debug(`mock API: 404 for ${req.method} ${req.url}`);
				res.writeHead(404);
				res.end();
				return;
			}
			let body: MessagesBody;
			try {
				body = JSON.parse(raw) as MessagesBody;
				on_messages(raw, body);
			} catch (error) {
				log.warn(`mock API: unreadable Messages request: ${String(error)}`);
				res.writeHead(400);
				res.end();
				return;
			}
			write_ok_reply(res, body);
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	return { server, base_url: `http://127.0.0.1:${port}` };
}

/**
 * An interactive `claude` running in a pseudo-terminal provided by
 * script(1), with its output kept for readiness checks and error messages.
 */
class TuiSession {
	readonly #child: ChildProcess;
	readonly #exited: Promise<unknown>;
	#output         = "";
	#last_output_ms = 0;
	#exit_code: number | null | undefined;

	/**
	 * @param argv binary path and arguments; must not contain single quotes
	 * @param cwd working directory of the session
	 * @param env complete environment of the session
	 */
	constructor(argv: string[], cwd: string, env: Record<string, string>) {
		for (const arg of argv) {
			A(!arg.includes("'"), () => `argument ${arg} contains a single quote`);
		}
		const command = argv.map((arg) => `'${arg}'`).join(" ");
		this.#child = spawn("script", ["-qfec", command, "/dev/null"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const on_output = (chunk: Buffer) => {
			this.#output         = (this.#output + chunk.toString("utf8")).slice(-65_536);
			this.#last_output_ms = Date.now();
		};
		this.#child.stdout!.on("data", on_output);
		this.#child.stderr!.on("data", on_output);
		// Keys typed while the session is exiting may hit a closed pipe.
		this.#child.stdin!.on("error", () => {});
		this.#exited = once(this.#child, "exit");
		this.#child.on("exit", (code) => {
			this.#exit_code = code;
		});
	}

	/** Wait until the TUI has drawn something and then gone quiet for QUIET_MS. */
	async wait_until_quiet(): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (this.#last_output_ms === 0 || Date.now() - this.#last_output_ms < QUIET_MS) {
			this.#check_alive();
			A.lt(Date.now(), deadline, () => `TUI did not settle within ${READY_TIMEOUT_MS} ms:\n${this.tail()}`);
			await sleep(100);
		}
	}

	/**
	 * Wait for a promise while the session is alive.
	 * @param promise what to wait for; must not resolve to undefined
	 * @param timeout_ms how long to wait
	 * @returns the promise's value, or undefined on timeout
	 */
	async wait_for<T>(promise: Promise<T>, timeout_ms: number): Promise<T | undefined> {
		const deadline = Date.now() + timeout_ms;
		while (Date.now() < deadline) {
			const value = await Promise.race([promise, sleep(100, undefined)]);
			if (value !== undefined) {
				return value;
			}
			this.#check_alive();
		}
		return undefined;
	}

	/** @param keys text or control characters to send to the terminal */
	type(keys: string): void {
		this.#child.stdin!.write(keys);
	}

	/** @returns the end of the output with escape sequences removed, for error messages */
	tail(): string {
		// oxlint-disable-next-line no-control-regex
		return this.#output.replace(/\x1b(\[[0-9;?<>=]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-Za-z]|.)/g, "").slice(-2000);
	}

	/**
	 * Quit with Ctrl-C (a second one confirms) and wait for the exit, so that
	 * claude is not still writing into its home afterwards. Failing that,
	 * SIGTERM: claude runs in a session of its own under script(1), out of
	 * reach of signals to script, but script passes SIGTERM on to it.
	 */
	async close(): Promise<void> {
		const deadline = Date.now() + EXIT_TIMEOUT_MS;
		while (this.#exit_code === undefined && Date.now() < deadline) {
			this.type("\x03");
			await sleep(300);
		}
		if (this.#exit_code === undefined) {
			log.warn(`session ignored Ctrl-C for ${EXIT_TIMEOUT_MS} ms; terminating it:\n${this.tail()}`);
			this.#child.kill("SIGTERM");
			await Promise.race([this.#exited, sleep(EXIT_TIMEOUT_MS)]);
		}
		if (this.#exit_code === undefined) {
			log.error(`session survived SIGTERM for ${EXIT_TIMEOUT_MS} ms; killing script(1), which may leave claude running`);
			this.#child.kill("SIGKILL");
			await this.#exited;
		}
	}

	#check_alive(): void {
		A.eq(this.#exit_code, undefined, () => `session exited:\n${this.tail()}`);
	}
}

/**
 * Global config that skips the first-run dialogs: onboarding, approving the
 * API key from the environment, and trusting the working directory.
 * @param cwd the session's working directory
 */
function seed_config(cwd: string): object {
	return {
		hasCompletedOnboarding: true,
		theme:                  "dark",
		customApiKeyResponses:  { approved: [API_KEY.slice(-20)], rejected: [] },
		projects:               { [cwd]: { hasTrustDialogAccepted: true } },
	};
}

/**
 * Start an interactive session of a binary with an empty home and working
 * directory, type PROMPT, and capture the Messages request that carries it.
 * @param binary_path runnable claude executable
 * @param model_arg value for --model
 * @param label version and series, for messages
 * @returns the raw JSON body of that request
 */
async function capture_initial_request(binary_path: string, model_arg: string, label: string): Promise<string> {
	const dir  = await mkdtemp(join(tmpdir(), "claude-context-"));
	const home = join(dir, "home");
	const cwd  = join(dir, "cwd");
	await mkdir(home);
	await mkdir(cwd);
	await writeFile(join(home, ".claude.json"), JSON.stringify(seed_config(cwd)));

	const main_request = Promise.withResolvers<string>();
	const { server, base_url } = await start_mock_api((raw, body) => {
		if (is_initial_request(body)) {
			main_request.resolve(raw);
		}
	});
	const session = new TuiSession([binary_path, "--model", model_arg], cwd, {
		PATH:                process.env["PATH"] ?? "/usr/bin:/bin",
		HOME:                home,
		TERM:                "xterm-256color",
		ANTHROPIC_BASE_URL:  base_url,
		ANTHROPIC_API_KEY:   API_KEY,
		DISABLE_AUTOUPDATER: "1",
	});
	try {
		// A dialog shown at startup (e.g. 2.1.42's "Welcome to Opus 4.6" effort
		// choice) takes the keys, and Enter picks its default; the prompt box
		// is empty afterwards, so submit again.
		for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
			await session.wait_until_quiet();
			session.type(PROMPT);
			await sleep(300);
			session.type("\r");
			const raw = await session.wait_for(main_request.promise, SUBMIT_WAIT_MS);
			if (raw !== undefined) {
				return raw;
			}
			log.debug(`${label}: no request after submit ${attempt}; submitting again`);
		}
		throw new Error(`no request with tools after submitting the prompt ${SUBMIT_ATTEMPTS} times:\n${session.tail()}`);
	} finally {
		await session.close();
		server.closeAllConnections();
		server.close();
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * capture_initial_request, retried: sessions occasionally crash early on
 * (seen in a 2.0.x session: a WebAssembly "access to a null reference").
 * @param binary_path runnable claude executable
 * @param model_arg value for --model
 * @param label version and series, for messages
 * @returns the raw JSON body of the captured request
 */
async function capture_with_retries(binary_path: string, model_arg: string, label: string): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await capture_initial_request(binary_path, model_arg, label);
		} catch (error) {
			if (attempt === CAPTURE_ATTEMPTS) {
				throw new Error(`${label}: all ${attempt} capture attempts failed`, { cause: error });
			}
			log.warn(`${label}: capture attempt ${attempt} failed; retrying. ${String(error)}`);
		}
	}
}

/**
 * @param version e.g. "2.1.296"
 * @param series the measured model
 * @returns path of the saved request; it holds `null` when the series was not tried
 */
function capture_path(version: string, series: Series): string {
	return join(CAPTURE_DIR, `${version}-${series.key}.json`);
}

/**
 * Extract a version's claude binary and make it runnable here: its ELF
 * interpreter is pointed at the loader this node uses, since the binary's
 * own /lib64 loader path does not exist everywhere (e.g. NixOS).
 * @param row the version's linux-x64 package
 * @param binary_path where to write the executable
 * @param interpreter path of the dynamic loader to use
 * @param needles strings to look for in the binary
 * @returns the needles that occur in the binary
 */
async function extract_runnable_binary(row: VsixRow, binary_path: string, interpreter: string, needles: string[]): Promise<Set<string>> {
	const { stdout: binary } = await exec_file("unzip", ["-p", join(VSIX_DIR, row.vsix_file), BINARY_ENTRY], {
		encoding:  "buffer",
		maxBuffer: 1024 * 1024 * 1024,
	});
	A.eq(binary.length, row.claude_size, () => `${row.vsix_file}: extracted size differs from ${INPUT_JSONL}`);
	await writeFile(binary_path, binary);
	await chmod(binary_path, 0o755);
	await exec_file("patchelf", ["--set-interpreter", interpreter, binary_path]);
	return new Set(needles.filter((needle) => binary.includes(needle)));
}

/**
 * Capture the initial request of one version for each given series, running
 * the binary from a scratch directory.
 * @param row the version's linux-x64 package
 * @param series the series still missing for this version
 * @param interpreter path of the dynamic loader to use
 */
async function capture_version(row: VsixRow, series: Series[], interpreter: string): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "claude-context-bin-"));
	try {
		const binary_path = join(dir, "claude");
		const found = await extract_runnable_binary(row, binary_path, interpreter, series.flatMap((s) => s.requires ?? []));
		for (const s of series) {
			const tried = s.requires === undefined || found.has(s.requires);
			const raw   = tried ? await capture_with_retries(binary_path, s.model_arg, `${row.version} ${s.key}`) : "null";
			// Written whole or not at all, since an existing capture counts as final.
			const path = capture_path(row.version, s);
			await writeFile(`${path}.tmp`, raw);
			await rename(`${path}.tmp`, path);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
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

/** @returns total UTF-8 size of the texts, in bytes */
function utf8_bytes(texts: string[]): number {
	return texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
}

/**
 * Measure the parts of a captured initial request.
 * @param body the parsed request
 * @param label for error messages
 * @returns sizes in UTF-8 bytes, and the number of tools
 */
function measure_request(body: MessagesBody, label: string): Pick<ContextRow, "system" | "tools" | "tool_count" | "messages" | "total"> {
	const system_texts  = text_blocks(body.system ?? [], label).filter((text) => !text.startsWith(BILLING_HEADER));
	const message_texts = body.messages.flatMap((message) => text_blocks(message.content, `${label} ${message.role} message`));
	A(is_initial_request(body), () => `${label}: not a request opening the conversation with the typed prompt`);
	// A deferred tool's definition stays out of the context until searched
	// for; counting it as context would need a rule of its own.
	const deferred = body.tools!.filter((tool) => tool.defer_loading === true).map((tool) => tool.name);
	A.eq(deferred.join(","), "", () => `${label}: deferred tools`);
	const system   = utf8_bytes(system_texts);
	const tools    = Buffer.byteLength(JSON.stringify(body.tools));
	const messages = utf8_bytes(message_texts) - Buffer.byteLength(PROMPT);
	return { system, tools, tool_count: body.tools!.length, messages, total: system + tools + messages };
}

async function main(): Promise<void> {
	await configure({
		sinks:   { console: getConsoleSink() },
		loggers: [
			{ category: "context",           sinks: ["console"], lowestLevel: "info" },
			{ category: ["logtape", "meta"], sinks: ["console"], lowestLevel: "warning" },
		],
	});
	await enter_sandbox();
	const jsonl = await readFile(INPUT_JSONL, "utf8");
	const rows  = jsonl.trimEnd().split("\n")
		.map((line) => JSON.parse(line) as VsixRow)
		.filter((row) => row.platform === PLATFORM && row.claude_size !== null);
	A.gt(rows.length, 0, () => `no ${PLATFORM} rows with a claude binary in ${INPUT_JSONL}`);

	// A saved capture is final: the download stage never overwrites a .vsix,
	// so a version's binary cannot change. Pass --full to capture everything
	// again (e.g. after changing how sessions are set up).
	await mkdir(CAPTURE_DIR, { recursive: true });
	const saved   = process.argv.includes("--full") ? new Set<string>() : new Set((await readdir(CAPTURE_DIR)).map((name) => join(CAPTURE_DIR, name)));
	const pending = rows
		.map((row) => ({ row, series: SERIES.filter((s) => !saved.has(capture_path(row.version, s))) }))
		.filter(({ series }) => series.length > 0);
	log.info(`capturing ${pending.reduce((n, p) => n + p.series.length, 0)} sessions across ${pending.length} of ${rows.length} ${PLATFORM} versions`);

	const { stdout: interpreter } = await exec_file("patchelf", ["--print-interpreter", process.execPath]);
	// After a failure, the other workers finish their current version instead
	// of being cut off, so that their sessions exit and scratch dirs go away.
	let next_index = 0;
	let done       = 0;
	let failed     = false;
	const worker = async () => {
		while (!failed) {
			const index = next_index++;
			if (index >= pending.length) {
				return;
			}
			const { row, series } = pending[index]!;
			try {
				await capture_version(row, series, interpreter.trim());
			} catch (error) {
				failed = true;
				throw error;
			}
			done++;
			if (done % 10 === 0) {
				log.info(`[${done}/${pending.length}] versions captured`);
			}
		}
	};
	const outcomes = await Promise.allSettled(Array.from({ length: WORKERS }, worker));
	for (const outcome of outcomes) {
		if (outcome.status === "rejected") {
			throw outcome.reason;
		}
	}

	const results: ContextRow[] = [];
	for (const row of rows) {
		for (const s of SERIES) {
			const label = capture_path(row.version, s);
			const body  = JSON.parse(await readFile(label, "utf8")) as MessagesBody | null;
			// An unresolved alias is sent on verbatim: this version lacks the series.
			if (body === null || !body.model.startsWith("claude-")) {
				continue;
			}
			results.push({
				version:      row.version,
				platform:     row.platform,
				release_date: row.release_date,
				series:       s.key,
				model:        body.model,
				...measure_request(body, label),
			});
		}
	}
	results.sort((a, b) => (Date.parse(a.release_date) - Date.parse(b.release_date)) || a.version.localeCompare(b.version));
	await writeFile(OUTPUT_JSONL, results.map((r) => `${JSON.stringify(r)}\n`).join(""));
	log.info(`wrote ${results.length} rows to ${OUTPUT_JSONL}`);
	for (const s of SERIES) {
		const measured = results.filter((r) => r.series === s.key);
		log.info(`${s.key}: ${measured.length} versions, from ${measured[0]?.version ?? "-"} to ${measured.at(-1)?.version ?? "-"}`);
	}
}

await main();
