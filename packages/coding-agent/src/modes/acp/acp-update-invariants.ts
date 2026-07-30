/**
 * Wire-level postcondition checks for every outbound `session/update`.
 *
 * Two ACP invariants (`docs/acp-development.md` rules 7 and 9) are properties
 * of the *emitted frame*, not of any one code path that builds it:
 *
 * 1. For a client that negotiated `clientCapabilities._meta.terminal_output`
 *    (Zed always does — `agent_servers/acp.rs:757`), a terminal-bearing
 *    `content` array renders exclusively through Zed's terminal card
 *    (`has_terminals` in `conversation_view/thread_view.rs`), silently
 *    dropping every sibling `content` item — so for that client the terminal
 *    item must be the array's only item. A client that hasn't negotiated the
 *    extension has no such renderer quirk (the ACP schema itself imposes no
 *    exclusivity — `docs/protocol/v1/tool-calls.mdx`), so the mapper's
 *    best-effort sibling-content fallback for that case is legitimate and
 *    exempt from this rule.
 *
 * Both were previously enforced by remembering to grep, which is why each was
 * rediscovered several times over in review: the violating shape usually only
 * exists after `content` arrays from different builders are merged
 * (`mergeToolUpdateContent`, image/notice spreads), so no single source
 * location is wrong to look at. Checking the finished notification at the one
 * chokepoint every frame passes through (`AcpAgent`'s `#sendUpdate`) covers
 * dynamically assembled content, code paths not yet written, and frames the
 * mapper never produced — and makes every existing ACP test and `acp-probe`
 * run a regression test for both rules at no authoring cost.
 *
 * The check never rewrites the frame: masking a violation on the wire would
 * hide the bug it exists to surface. Under `bun test` it throws; in a real
 * session it logs and lets the frame through, so a guard bug can never kill a
 * live connection.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk";
import { logger } from "@oh-my-pi/pi-utils";

export interface AcpInvariantContext {
	/** `clientCapabilities._meta.terminal_output === true` for this connection. */
	terminalMetaCapable: boolean;
}

/** `_meta` keys belonging to Zed's display-only terminal extension. */
const TERMINAL_META_KEY = /^terminal_/;

let strict = process.env.NODE_ENV === "test";

/**
 * Throw instead of logging on a violation. On by default under `bun test`
 * (which sets `NODE_ENV=test`), so the existing ACP suites enforce both rules
 * without opting in individually.
 */
export function setStrictAcpInvariantsForTesting(value: boolean): void {
	strict = value;
}

export function getStrictAcpInvariantsForTesting(): boolean {
	return strict;
}

/**
 * Describe every invariant violation in `notification`, or an empty array when
 * it is well-formed. Pure — never mutates the notification.
 */
export function checkAcpUpdateInvariants(notification: SessionNotification, context: AcpInvariantContext): string[] {
	const update = notification.update;
	if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
		return [];
	}
	const violations: string[] = [];
	const toolCallId = update.toolCallId;
	const content = update.content;

	if (context.terminalMetaCapable && Array.isArray(content) && content.length > 1) {
		const terminalIds = content
			.filter(item => item?.type === "terminal")
			.map(item => (item.type === "terminal" ? item.terminalId : undefined));
		if (terminalIds.length > 0) {
			const siblings = content
				.filter(item => item?.type !== "terminal")
				.map(item =>
					item?.type === "content" ? `content/${item.content?.type ?? "unknown"}` : (item?.type ?? "unknown"),
				);
			violations.push(
				`tool call ${toolCallId} sends ${siblings.length} sibling content item(s) [${siblings.join(", ")}] ` +
					`alongside terminal item(s) [${terminalIds.join(", ")}] for a terminalMetaCapable client; Zed's ` +
					`has_terminals renders the terminal exclusively and drops the siblings. Deliver the extra facts as ` +
					`_meta.terminal_output bytes on the same terminal id instead.`,
			);
		}
	}

	if (!context.terminalMetaCapable && update._meta) {
		const ungated = Object.keys(update._meta).filter(key => TERMINAL_META_KEY.test(key));
		if (ungated.length > 0) {
			violations.push(
				`tool call ${toolCallId} emits ungated _meta key(s) [${ungated.join(", ")}]; the client never ` +
					`negotiated clientCapabilities._meta.terminal_output, so it must get the fenced-text fallback instead.`,
			);
		}
	}

	return violations;
}

/**
 * Report every violation in `notification`: throws under strict mode (tests),
 * logs otherwise. Callers emit the frame either way.
 */
export function assertAcpUpdateInvariants(notification: SessionNotification, context: AcpInvariantContext): void {
	const violations = checkAcpUpdateInvariants(notification, context);
	if (violations.length === 0) return;
	const message = `ACP update invariant violation: ${violations.join(" | ")}`;
	if (strict) {
		throw new Error(message);
	}
	logger.error(message, { sessionId: notification.sessionId });
}
