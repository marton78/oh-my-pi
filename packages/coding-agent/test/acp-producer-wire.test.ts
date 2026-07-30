import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { mapAgentSessionEventToAcpSessionUpdates } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { checkAcpUpdateInvariants } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-update-invariants";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool, type BashToolDetails } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

/**
 * Crosses the exact seam that let oh-my-pi/oh-my-pi#7078 review 4821242767's
 * finding 2 ship: every other ACP test in this suite fabricates
 * `details`/`details.meta` by hand, so nothing ever asked whether the real
 * `BashTool` producer actually populates the field the mapper reads. Here the
 * tool result comes from a real `BashTool.execute()` call (wrapped exactly as
 * production wraps it, `wrapToolWithMetaNotice`), fed straight into the
 * mapper, with `checkAcpUpdateInvariants` run on the emitted frame — the same
 * chokepoint check `AcpAgent#sendUpdate` runs, so this also stands in for a
 * producer-to-wire crossing of rule 7/9 enforcement.
 */

const cleanupRoots: string[] = [];

afterEach(async () => {
	for (const root of cleanupRoots.splice(0)) {
		await fs.promises.rm(root, { recursive: true, force: true });
	}
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
});
