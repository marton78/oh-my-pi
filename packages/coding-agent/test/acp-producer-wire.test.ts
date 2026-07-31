import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import type { EvalToolDetails } from "@oh-my-pi/pi-coding-agent/eval/types";
import type { DaemonBrokerClient } from "@oh-my-pi/pi-coding-agent/launch/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonRpcResult } from "@oh-my-pi/pi-coding-agent/launch/protocol";
import { mapAgentSessionEventToAcpSessionUpdates } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { checkAcpUpdateInvariants } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-update-invariants";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { executeLaunch } from "@oh-my-pi/pi-coding-agent/tools/hub/launch";
import {
	formatOutputNotice,
	type OutputMeta,
	wrapToolWithMetaNotice,
} from "@oh-my-pi/pi-coding-agent/tools/output-meta";

/**
 * Crosses the seam every other ACP test skips: the mapper suite fabricates
 * `details` by hand, so nothing there can ask whether a real producer actually
 * populates the field the mapper reads. Six review findings on
 * oh-my-pi/oh-my-pi#7078 lived in that gap (the spilled-artifact pointer, a
 * failing eval's status and exit code, …), each found by a reviewer rather
 * than by a test.
 *
 * So the coverage here is a matrix, not a case per bug: every ACP-relevant
 * producer outcome runs through its real tool (wrapped exactly as production
 * wraps it, `wrapToolWithMetaNotice`), into the mapper, in both capability
 * modes, and every case gets the same three generic assertions —
 *
 *   1. the frame's `status`/`terminal_exit.exit_code` match the outcome
 *      declared in the table (declared by hand from what the command did, so
 *      the assertion can't restate the mapper's own derivation);
 *   2. no fact the producer recorded structurally (`details.notices`,
 *      `details.notice`, `details.meta`'s rendered notice) is missing from the
 *      frame — the general form of the artifact-pointer loss, which no
 *      per-frame shape check could see;
 *   3. `checkAcpUpdateInvariants` passes, the same chokepoint check
 *      `AcpAgent#sendUpdate` runs.
 *
 * Adding a producer outcome is one table row, so the next producer with a
 * details-only fact is covered before a reviewer has to find it.
 */

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSpillingSession(): { session: ToolSession; artifactDir: string } {
	const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-producer-wire-"));
	cleanupRoots.push(artifactDir);
	let nextArtifactId = 0;
	const session = {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			// Real resolution: the client-terminal path wraps the command line
			// through it (`wrapShellLineForClientTerminal`).
			getShellConfig: () => Settings.isolated().getShellConfig(),
		},
		getClientBridge: () => undefined,
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { path: path.join(artifactDir, `${id}.txt`), id };
		},
		saveArtifact: async (text: string) => {
			const id = String(nextArtifactId++);
			fs.writeFileSync(path.join(artifactDir, `${id}.txt`), text);
			return id;
		},
	} as unknown as ToolSession;
	return { session, artifactDir };
}

/**
 * `seq 1 20000` is deterministic and portable (unlike `python3`/`printf
 * '%0.s'`, which vary or error across shells), and its ~110KB of output
 * comfortably exceeds the default 50KB `tools.artifactSpillThreshold`, so
 * `OutputSink` spills and elides before `BashTool` ever applies its own
 * final-defense inline cap — the common path, not the timeout/edge path.
 */
const SPILLING_COMMAND = "seq 1 20000";

/**
 * 3000 fixed-width 64-byte lines (~192 KB), each carrying its own index so no
 * two windows of the stream are byte-identical (self-similar filler would make
 * the append-only probe below fire on legitimate deliveries). The width matters: bash streams
 * through a `TailBuffer(DEFAULT_MAX_BYTES)` that trims to a line boundary, and
 * 51,200 / 64 is exact, so the last streamed snapshot lands *exactly* on the
 * 50 KB rollover floor every run instead of a line-width-dependent byte or two
 * under it — the difference between reproducing
 * oh-my-pi/oh-my-pi#7078 review 4824091334 and passing by luck. The final
 * result is then `OutputSink`'s middle-elided head+tail summary, which starts
 * with the run's original head (zero overlap with the streamed tail) and is
 * longer than the watermark once its elision marker and notices are appended.
 */
const WIDE_LINE_COMMAND = `awk 'BEGIN{for(i=0;i<3000;i++) printf "%063d\\n", i}'`;

async function runSpillingBash(): Promise<{
	result: AgentToolResult<BashToolDetails>;
	artifactDir: string;
}> {
	const { session, artifactDir } = makeSpillingSession();
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const result = await tool.execute("call-spill", { command: SPILLING_COMMAND });
	return { result, artifactDir };
}

/**
 * A real `EvalTool.execute()` whose backend exits nonzero. The backend is
 * stubbed (deterministic, no interpreter dependency) but the result builder
 * under test is the real one — and it is the producer half of this seam: it
 * records the failure in `details.isError`/`details.cells[].exitCode` and
 * never marks the result-level `isError`, which is the only signal the ACP
 * mapper used to read.
 */
async function runFailingEval(toolCallId: string): Promise<{
	result: AgentToolResult<EvalToolDetails | undefined>;
	args: Record<string, unknown>;
}> {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () => ({
		output: "boom\n",
		exitCode: 1,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 1,
		totalBytes: 5,
		outputLines: 1,
		outputBytes: 5,
		displayOutputs: [],
	})) as never);
	const session = {
		cwd: "/tmp/eval-acp-wire",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
	const args = { language: "js", code: "process.exit(1)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(session));
	const result = (await tool.execute(toolCallId, args)) as AgentToolResult<EvalToolDetails | undefined>;
	return { result, args };
}

describe("ACP producer-to-wire crossing", () => {
	it("a real spilled BashTool result carries an artifact pointer the mapper can recover", async () => {
		const { result } = await runSpillingBash();
		// Precondition: this run must actually cross the spill threshold
		// (`meta.truncation.artifactId`) — otherwise a config change on the
		// test machine would turn this into a vacuous pass instead of a clear
		// failure.
		const meta = (result.details as { meta?: { truncation?: { artifactId?: string } } } | undefined)?.meta;
		expect(meta?.truncation?.artifactId).toBeDefined();
		// And the gap this test exists to catch: bash's own `details.notices`
		// does NOT carry the pointer (that's the whole bug).
		const notices = (result.details as { notices?: string[] } | undefined)?.notices ?? [];
		expect(notices.some(n => n.includes("artifact://"))).toBe(false);
	});

	it("delivers the spilled artifact pointer to a meta-capable ACP client with no invariant violation", async () => {
		const { result } = await runSpillingBash();
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-spill",
			toolName: "bash",
			isError: result.isError === true,
			result: { ...result, details: { ...result.details, terminalId: "term-spill-wire" } },
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: true, realTerminalCapable: true };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: true };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as { _meta?: { terminal_output?: { data: string } } };
		expect(update._meta?.terminal_output?.data).toContain("artifact://");
	});

	it("delivers the spilled artifact pointer as sibling content to a non-meta-capable ACP client with no invariant violation", async () => {
		const { result } = await runSpillingBash();
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-spill",
			toolName: "bash",
			isError: result.isError === true,
			result: { ...result, details: { ...result.details, terminalId: "term-spill-wire-2" } },
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: false };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: false };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as {
			content?: { type: string; content?: { type: string; text?: string } }[];
		};
		const textItem = update.content?.find(item => item.type === "content" && item.content?.type === "text");
		expect(textItem?.content?.text).toContain("artifact://");
	});

	it("a real failing EvalTool result records its failure only in details", async () => {
		const { result } = await runFailingEval("call-eval-fail");
		// Precondition, and the whole reason the mapper has to look deeper:
		// eval's result builder never calls `.error()`, so `tool_execution_end`
		// carries `isError: false` for a cell that exited nonzero.
		expect(result.isError).not.toBe(true);
		expect(result.details?.isError).toBe(true);
		expect(result.details?.cells?.[0]?.exitCode).toBe(1);
		expect(result.content.map(c => (c.type === "text" ? c.text : "")).join("\n")).toContain(
			"Command exited with code 1",
		);
	});

	it("reports a real failing eval as failed with its true exit code to a meta-capable ACP client", async () => {
		const { result, args } = await runFailingEval("call-eval-fail-wire");
		const event: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: "call-eval-fail-wire",
			toolName: "eval",
			args,
			isError: result.isError === true,
			result,
		} as AgentSessionEvent;
		const options = { terminalMetaCapable: true };
		const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);

		expect(updates).toHaveLength(1);
		const context = { terminalMetaCapable: true };
		for (const update of updates) {
			expect(checkAcpUpdateInvariants(update, context)).toEqual([]);
		}
		const update = updates[0]!.update as {
			status?: string;
			_meta?: { terminal_exit?: { exit_code?: number | null }; terminal_output?: { data: string } };
		};
		// The terminal body says the command failed, so the terminal's own exit
		// status and the card's status must say so too.
		expect(update._meta?.terminal_output?.data).toContain("Command exited with code 1");
		expect(update._meta?.terminal_exit?.exit_code).toBe(1);
		expect(update.status).toBe("failed");
	});
});

// =============================================================================
// Producer matrix
// =============================================================================

interface ProducerOutcome {
	toolName: string;
	args: Record<string, unknown>;
	result: AgentToolResult<unknown>;
	/**
	 * Every partial result the producer pushed through `onUpdate`, in order.
	 * Replaying these through the mapper before the final result is what makes
	 * the delta/watermark machinery observable: a matrix that only feeds
	 * `tool_execution_end` leaves `getMetaTerminalSent` empty, so every frame
	 * takes the first-send path and no incremental state is ever exercised.
	 */
	updates: AgentToolResult<unknown>[];
}

/**
 * The rendering worlds a producer's result can land in. `meta` is the
 * display-only terminal convention for a client that understands
 * `_meta.terminal_output` but hosts no real terminal (Zed during
 * `session/load` replay, any bash/exec call with `pty: true`, every `eval`) —
 * the only world where the incremental delta/watermark code runs, and the one
 * the matrix originally had no mode for.
 */
const MODES = {
	zed: { terminalMetaCapable: true, realTerminalCapable: true },
	meta: { terminalMetaCapable: true, realTerminalCapable: false },
	"real-terminal-only": { terminalMetaCapable: false, realTerminalCapable: true },
	plain: { terminalMetaCapable: false, realTerminalCapable: false },
} as const;

type ModeName = keyof typeof MODES;

interface ProducerCase {
	name: string;
	run: (toolCallId: string) => Promise<ProducerOutcome>;
	/**
	 * Declared by hand from what the command actually did — never derived from
	 * the result, so the assertion can't restate the mapper's own logic.
	 */
	status: "completed" | "failed";
	/** `undefined` = the frame must not claim an exit code it cannot know. */
	exitCode?: number;
	/** The call created a client-owned terminal the frame must still reference. */
	terminalId?: string;
	/**
	 * How many `[terminal output discontinuity]` notices the whole frame
	 * sequence may carry. Declared per row from what the producer did: only a
	 * run whose own tail buffer rolls between two `onUpdate` snapshots
	 * genuinely loses bytes the mapper never saw, and only then may the mapper
	 * say so. Default 0 — a claim of dropped bytes on a fully-replayed stream
	 * is a fabrication.
	 */
	discontinuities?: number;
	modes?: readonly ModeName[];
}

function makeEvalSession(): ToolSession {
	return {
		cwd: "/tmp/eval-acp-wire",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

function stubJsBackend(overrides: Record<string, unknown>): void {
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async () => ({
		output: "",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		artifactId: undefined,
		totalLines: 0,
		totalBytes: 0,
		outputLines: 0,
		outputBytes: 0,
		displayOutputs: [],
		...overrides,
	})) as never);
}

async function runEval(toolCallId: string, backend: Record<string, unknown>): Promise<ProducerOutcome> {
	stubJsBackend(backend);
	const args = { language: "js", code: "print('x')" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

/**
 * A real `EvalTool.execute()` whose backend streams `chunks` through `onChunk`
 * before returning, so the mapper sees a genuine multi-update sequence and the
 * watermark/delta path is exercised the way a long-running cell exercises it.
 * `total` bytes past eval's own `TailBuffer(DEFAULT_MAX_BYTES * 2)` window make
 * its final result a re-rendered summary rather than a continuation.
 */
async function runStreamingEval(toolCallId: string, lines: number): Promise<ProducerOutcome> {
	const chunks: string[] = [];
	for (let i = 0; i < lines; i++) chunks.push(`${String(i).padStart(63, "0")}\n`);
	const output = chunks.join("");
	vi.spyOn(evalIndex.jsBackend, "execute").mockImplementation((async (
		_code: string,
		options: { onChunk?: (chunk: string) => void },
	) => {
		for (const chunk of chunks) options.onChunk?.(chunk);
		return {
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			artifactId: undefined,
			totalLines: lines,
			totalBytes: output.length,
			outputLines: lines,
			outputBytes: output.length,
			displayOutputs: [],
		};
	}) as never);
	const args = { language: "js", code: "for (const l of lines) print(l)" } as const;
	const tool = wrapToolWithMetaNotice(new EvalTool(makeEvalSession()));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "eval", args: { ...args }, result, updates };
}

async function runBash(toolCallId: string, args: Record<string, unknown>): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args as { command: string }, undefined, update =>
		updates.push(update),
	);
	return { toolName: "bash", args, result, updates };
}

/**
 * A client-owned terminal that never exits, so the tool's own timeout fires
 * while the terminal is live — the one bash path that used to throw instead of
 * returning a result, discarding `details.terminalId` and every notice with it.
 */
const HUNG_TERMINAL_ID = "producer-wire-term-1";

async function runTimingOutBridgeBash(toolCallId: string): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const bridge = {
		capabilities: { terminal: true },
		createTerminal: async () => ({
			terminalId: HUNG_TERMINAL_ID,
			waitForExit: () => new Promise<never>(() => {}),
			currentOutput: async () => ({ output: "still working\n", truncated: false }),
			kill: async () => {},
			release: async () => {},
		}),
	};
	(session as { getClientBridge: () => unknown }).getClientBridge = () => bridge;
	const args = { command: "sleep 30", timeout: 1 };
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args, undefined, update => updates.push(update));
	return { toolName: "bash", args, result, updates };
}

/**
 * `hub start` against a daemon the broker reports as `failed`. The op records
 * that only in `details.daemon.state`, which the TUI card reads and the ACP
 * mapper cannot — so the producer marks the result-level flag now.
 */
async function runLaunch(op: "start" | "describe", state: string): Promise<ProducerOutcome> {
	const projectDir = process.cwd();
	const daemon = {
		name: "web",
		state,
		pid: 4242,
		exitReason: state === "failed" ? "exited with code 1 during startup" : undefined,
	};
	const rpcResult = (op === "start"
		? { op: "start", daemon, readyTimedOut: false }
		: {
				op: "describe",
				daemon,
				spec: {
					application: "bun",
					args: ["run", "dev"],
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			}) as unknown as DaemonRpcResult;
	vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue({
		projectDir,
		request: async () => rpcResult,
		close() {},
	} as DaemonBrokerClient);
	const args = op === "start" ? { op, name: "web", application: "bun", args: ["run", "dev"] } : { op, name: "web" };
	const result = await executeLaunch({ cwd: projectDir } as ToolSession, args as never);
	return { toolName: "hub", args, result, updates: [] };
}

/** A real multi-file `apply_patch` where the second file does not exist. */
async function runPartiallyFailingEdit(toolCallId: string): Promise<ProducerOutcome> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-producer-wire-edit-"));
	cleanupRoots.push(root);
	fs.writeFileSync(path.join(root, "a.txt"), "one\n");
	const session = {
		cwd: root,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		enableLsp: false,
		settings: Settings.isolated({ "edit.mode": "apply_patch" }),
		getArtifactsDir: () => null,
		getSessionId: () => null,
		getPlanModeState: () => undefined,
	} as unknown as ToolSession;
	const args = {
		input: [
			"*** Begin Patch",
			"*** Update File: a.txt",
			"@@",
			"-one",
			"+two",
			"*** Update File: missing.txt",
			"@@",
			"-nope",
			"+never",
			"*** End Patch",
			"",
		].join("\n"),
	};
	const tool = wrapToolWithMetaNotice(new EditTool(session));
	const updates: AgentToolResult<unknown>[] = [];
	const result = await tool.execute(toolCallId, args as never, undefined, update => updates.push(update));
	return { toolName: "edit", args, result, updates };
}

const PRODUCER_CASES: readonly ProducerCase[] = [
	{
		name: "bash, exit 0",
		run: id => runBash(id, { command: "echo hi" }),
		status: "completed",
		exitCode: 0,
	},
	{
		name: "bash, nonzero exit",
		run: id => runBash(id, { command: "sh -c 'echo hi; exit 3'" }),
		status: "failed",
		exitCode: 3,
	},
	{
		name: "bash, output spilled to an artifact",
		run: id => runBash(id, { command: SPILLING_COMMAND }),
		status: "completed",
		exitCode: 0,
		// ~110 KB through a 50 KB tail buffer: the bytes between the first
		// snapshot and the second really are gone before the mapper sees them,
		// so exactly one honest discontinuity notice is expected. Two means the
		// final re-rendered summary was misread as a rollover as well.
		discontinuities: 1,
	},
	{
		name: "bash, middle-elided summary after a rolled tail window",
		run: id => runBash(id, { command: WIDE_LINE_COMMAND }),
		status: "completed",
		exitCode: 0,
		// The producer's own 50 KB window rolls between the two snapshots it
		// emits for a 192 KB run, so one honest discontinuity is expected. The
		// second one the mapper used to add — for the final elided summary,
		// which is a re-render of what already streamed, not a continuation of
		// it — came with a duplicate copy of the whole summary.
		discontinuities: 1,
	},
	{
		name: "bash, timeout with a live client terminal",
		run: runTimingOutBridgeBash,
		status: "failed",
		terminalId: HUNG_TERMINAL_ID,
		modes: ["zed", "real-terminal-only"],
	},
	{
		name: "eval, exit 0",
		run: id => runEval(id, { output: "ok\n" }),
		status: "completed",
		exitCode: 0,
	},
	{
		name: "eval, nonzero exit",
		run: id => runEval(id, { output: "boom\n", exitCode: 1 }),
		status: "failed",
		exitCode: 1,
	},
	{
		name: "eval, aborted mid-cell",
		run: id => runEval(id, { output: "partial\n", cancelled: true }),
		status: "failed",
	},
	{
		name: "eval, streamed past its own tail-buffer window",
		run: id => runStreamingEval(id, 2500),
		status: "completed",
		exitCode: 0,
		// 160 KB through eval's 100 KB window: the bytes in between are gone
		// before the mapper can see them, so one honest discontinuity notice.
		discontinuities: 1,
	},
	{
		name: "hub start, daemon reported failed",
		run: () => runLaunch("start", "failed"),
		status: "failed",
	},
	{
		name: "hub describe of an already-failed daemon",
		run: () => runLaunch("describe", "failed"),
		status: "completed",
	},
	{
		name: "edit, multi-file patch with one missing file",
		run: runPartiallyFailingEdit,
		status: "failed",
	},
];

/** Every string a producer recorded structurally for a renderer to surface. */
function producerFacts(result: AgentToolResult<unknown>): string[] {
	const details = result.details;
	if (typeof details !== "object" || details === null) return [];
	const facts: string[] = [];
	const notices = (details as { notices?: unknown }).notices;
	if (Array.isArray(notices)) {
		for (const notice of notices) if (typeof notice === "string") facts.push(notice);
	}
	const single = (details as { notice?: unknown }).notice;
	if (typeof single === "string") facts.push(single);
	const meta = (details as { meta?: OutputMeta }).meta;
	if (meta) facts.push(formatOutputNotice(meta));
	return facts.flatMap(fact =>
		fact
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0),
	);
}

/** Every text channel the client can actually render for this frame. */
function frameTexts(update: Record<string, unknown>): string[] {
	const texts: string[] = [];
	const meta = update._meta as { terminal_output?: { data?: unknown } } | undefined;
	if (typeof meta?.terminal_output?.data === "string") texts.push(meta.terminal_output.data);
	const content = update.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (item?.type === "content" && item.content?.type === "text" && typeof item.content.text === "string") {
				texts.push(item.content.text);
			}
			if (item?.type === "diff") texts.push(String(item.newText ?? ""));
		}
	}
	return texts;
}

/**
 * Bytes a client would append to the display-only terminal, in delivery order.
 * `AcpAgent` keeps the watermark per tool call across the whole sequence
 * (`metaTerminalSent`), so the replay below has to as well or the incremental
 * path is never entered.
 */
function replayThroughMapper(
	toolCallId: string,
	outcome: ProducerOutcome,
	mode: (typeof MODES)[ModeName],
): { frames: SessionNotification[]; terminalChunks: string[] } {
	const watermarks = new Map<string, string>();
	const options = {
		...mode,
		getToolArgs: () => outcome.args,
		getMetaTerminalSent: (id: string) => watermarks.get(id),
		setMetaTerminalSent: (id: string, value: string) => {
			watermarks.set(id, value);
		},
	};
	const frames: SessionNotification[] = [];
	for (const partialResult of outcome.updates) {
		frames.push(
			...mapAgentSessionEventToAcpSessionUpdates(
				{
					type: "tool_execution_update",
					toolCallId,
					toolName: outcome.toolName,
					args: outcome.args,
					partialResult,
				} as AgentSessionEvent,
				"session-1",
				options,
			),
		);
	}
	const endFrames = mapAgentSessionEventToAcpSessionUpdates(
		{
			type: "tool_execution_end",
			toolCallId,
			toolName: outcome.toolName,
			args: outcome.args,
			isError: outcome.result.isError === true,
			result: outcome.result,
		} as AgentSessionEvent,
		"session-1",
		options,
	);
	frames.push(...endFrames);
	const terminalChunks: string[] = [];
	for (const frame of frames) {
		const meta = (frame.update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		if (typeof meta?.terminal_output?.data === "string") terminalChunks.push(meta.terminal_output.data);
	}
	return { frames: endFrames, terminalChunks };
}

const DISCONTINUITY_MARKER = "terminal output discontinuity";

/**
 * A terminal buffer is append-only: a client concatenates every
 * `terminal_output.data` it receives. Re-sending a body it already holds
 * duplicates what the user sees, so no chunk may repeat a substantial run of
 * already-delivered bytes. The 256-byte probe skips notice-sized chunks (whose
 * repetition is bounded and legible) while catching a re-sent output body.
 */
function expectAppendOnly(chunks: readonly string[]): void {
	let delivered = "";
	for (const chunk of chunks) {
		const body = chunk.replaceAll(/\n?\[[^\]]*terminal output discontinuity[^\]]*\]\n?/g, "");
		if (body.length >= 256) {
			expect(delivered.includes(body.slice(0, 256))).toBe(false);
		}
		delivered += chunk;
	}
}

describe("ACP producer matrix", () => {
	for (const producerCase of PRODUCER_CASES) {
		for (const modeName of producerCase.modes ?? (["zed", "meta", "plain"] as const)) {
			it(`${producerCase.name} → ${modeName}`, async () => {
				const toolCallId = `matrix-${producerCase.name.replace(/[^a-z0-9]+/gi, "-")}-${modeName}`;
				const outcome = await producerCase.run(toolCallId);
				const mode = MODES[modeName];
				const { frames, terminalChunks } = replayThroughMapper(toolCallId, outcome, mode);
				expect(frames).toHaveLength(1);
				const update = frames[0]!.update as unknown as Record<string, unknown>;

				// 1. Declared outcome.
				expect(update.status).toBe(producerCase.status);
				const exit = (update._meta as { terminal_exit?: { exit_code?: number } } | undefined)?.terminal_exit;
				if (exit) {
					expect(exit.exit_code).toBe(producerCase.exitCode);
				}
				if (producerCase.terminalId) {
					const content = update.content as Array<{ type: string; terminalId?: string }> | undefined;
					expect(
						content?.some(item => item.type === "terminal" && item.terminalId === producerCase.terminalId),
					).toBe(true);
				}

				// 2. No structurally-recorded producer fact silently dropped.
				const texts = [...frameTexts(update), ...terminalChunks].join("\n");
				for (const fact of producerFacts(outcome.result)) {
					expect(texts).toContain(fact);
				}

				// 3. Append-only terminal stream: nothing delivered twice.
				expectAppendOnly(terminalChunks);

				// 4. No fabricated data loss. The replay feeds the mapper every
				// snapshot the producer emitted, so it may only claim dropped
				// bytes when the producer's own tail buffer rolled between two of
				// them — declared per row, never inferred from the frames.
				const claimed = terminalChunks.filter(chunk => chunk.includes(DISCONTINUITY_MARKER)).length;
				expect(claimed).toBeLessThanOrEqual(producerCase.discontinuities ?? 0);

				// 5. Wire invariants, same check `AcpAgent#sendUpdate` runs.
				expect(checkAcpUpdateInvariants(frames[0]!, { terminalMetaCapable: mode.terminalMetaCapable })).toEqual([]);
			});
		}
	}
});
