import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
}

/** The three rendering worlds a producer's result can land in. */
const MODES = {
	zed: { terminalMetaCapable: true, realTerminalCapable: true },
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
	return { toolName: "eval", args: { ...args }, result: await tool.execute(toolCallId, args) };
}

async function runBash(toolCallId: string, args: Record<string, unknown>): Promise<ProducerOutcome> {
	const { session } = makeSpillingSession();
	const tool = wrapToolWithMetaNotice(new BashTool(session));
	return { toolName: "bash", args, result: await tool.execute(toolCallId, args as { command: string }) };
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
	return { toolName: "bash", args, result: await tool.execute(toolCallId, args) };
}

/**
 * `hub start` against a daemon the broker reports as `failed`. The op records
 * that only in `details.daemon.state`, which the TUI card reads and the ACP
 * mapper cannot — so the producer marks the result-level flag now.
 */
async function runLaunch(toolCallId: string, op: "start" | "describe", state: string): Promise<ProducerOutcome> {
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
	return { toolName: "hub", args, result };
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
	return { toolName: "edit", args, result: await tool.execute(toolCallId, args as never) };
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
		name: "hub start, daemon reported failed",
		run: id => runLaunch(id, "start", "failed"),
		status: "failed",
	},
	{
		name: "hub describe of an already-failed daemon",
		run: id => runLaunch(id, "describe", "failed"),
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

describe("ACP producer matrix", () => {
	for (const producerCase of PRODUCER_CASES) {
		for (const modeName of producerCase.modes ?? (["zed", "plain"] as const)) {
			it(`${producerCase.name} → ${modeName}`, async () => {
				const toolCallId = `matrix-${producerCase.name.replace(/[^a-z0-9]+/gi, "-")}-${modeName}`;
				const { toolName, args, result } = await producerCase.run(toolCallId);
				const event = {
					type: "tool_execution_end",
					toolCallId,
					toolName,
					args,
					isError: result.isError === true,
					result,
				} as AgentSessionEvent;
				const options = MODES[modeName];
				const updates = mapAgentSessionEventToAcpSessionUpdates(event, "session-1", options);
				expect(updates).toHaveLength(1);
				const update = updates[0]!.update as unknown as Record<string, unknown>;

				// 1. Declared outcome.
				expect(update.status).toBe(producerCase.status);
				const exit = (update._meta as { terminal_exit?: { exit_code?: number } } | undefined)?.terminal_exit;
				if (modeName === "zed" && exit) {
					expect(exit.exit_code).toBe(producerCase.exitCode);
				}
				if (producerCase.terminalId) {
					const content = update.content as Array<{ type: string; terminalId?: string }> | undefined;
					expect(
						content?.some(item => item.type === "terminal" && item.terminalId === producerCase.terminalId),
					).toBe(true);
				}

				// 2. No structurally-recorded producer fact silently dropped.
				const texts = frameTexts(update).join("\n");
				for (const fact of producerFacts(result)) {
					expect(texts).toContain(fact);
				}

				// 3. Wire invariants, same check `AcpAgent#sendUpdate` runs.
				expect(checkAcpUpdateInvariants(updates[0]!, { terminalMetaCapable: options.terminalMetaCapable })).toEqual(
					[],
				);
			});
		}
	}
});
