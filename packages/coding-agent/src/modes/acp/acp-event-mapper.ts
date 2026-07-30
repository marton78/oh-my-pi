import type {
	SessionNotification,
	SessionUpdate,
	ToolCall,
	ToolCallContent,
	ToolCallLocation,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { logger } from "@oh-my-pi/pi-utils";
import { parseXdUrl } from "../../internal-urls/xd-protocol";
import type { AgentSessionEvent } from "../../session/agent-session";
import { resolveToCwd } from "../../tools/path-utils";
import type { TodoStatus } from "../../tools/todo";
import { canonicalizeMessage } from "../../utils/thinking-display";

interface MessageProgress {
	textEmitted: boolean;
	thoughtEmitted: boolean;
}

interface AcpEventMapperOptions {
	getMessageId?: (message: unknown) => string | undefined;
	getMessageProgress?: (message: unknown) => MessageProgress | undefined;
	getToolArgs?: (toolCallId: string) => unknown;
	resolveImageData?: (data: string, mimeType: string | undefined) => string;
	/**
	 * Session cwd. Tool call locations sent to ACP clients must be absolute
	 * (the editor host needs them to open or focus files). When provided,
	 * the mapper resolves raw `path`/`file`/etc. args against this cwd
	 * before emitting `ToolCallLocation` entries.
	 */
	cwd?: string;
	/**
	 * Whether `terminalId` names a terminal the connected client created on this
	 * connection. Ids restored from a persisted transcript (`session/load`
	 * replay) belong to a previous process's terminals, which the client cannot
	 * render, so those tool calls fall back to emitting the recorded output as
	 * text. Defaults to treating every id as live.
	 */
	isTerminalLive?: (terminalId: string) => boolean;
	/**
	 * Whether the connected client understands the display-only terminal
	 * `_meta` convention Zed's ACP bridge and `claude-agent-acp` use to render
	 * a rich, expandable terminal block for output with no live client-owned
	 * `terminal/create` terminal behind it: `terminal_info` on the tool
	 * call's start, `terminal_output`/`terminal_exit` on its completion, all
	 * keyed by an agent-chosen `terminal_id`. Negotiated from
	 * `clientCapabilities._meta.terminal_output === true` at `initialize`.
	 * When false, execute-kind tools with no live terminal fall back to a
	 * fenced text block instead — the client cannot render the terminal
	 * content otherwise.
	 */
	terminalMetaCapable?: boolean;
	/**
	 * Whether the connected client supports real, client-owned terminals
	 * (`clientCapabilities.terminal === true`) — the live path `bash`/
	 * `shell`/`exec` attempt via `terminal/create` before ever falling back
	 * to the meta-terminal convention above. `eval` never uses a live
	 * terminal regardless of this flag. Always `false` during `session/load`
	 * replay: no live process exists to attach a new client terminal to, no
	 * matter how capable the client is.
	 */
	realTerminalCapable?: boolean;
	/**
	 * The full cumulative meta-terminal output text already delivered to the
	 * client for `toolCallId` (raw output only — never the eval source header
	 * `buildTerminalMetaOutputData` prepends once up front), or `undefined` if
	 * nothing has been sent yet. `tool_execution_update`/`tool_execution_end`
	 * both carry the entire output-so-far (see `streamTailUpdates`/`eval.ts`'s
	 * `pushUpdate`), but Zed's `terminal_output.data` is append-only bytes —
	 * resending the same prefix on every progress tick and again at
	 * completion duplicates it in the client's terminal. Backed by
	 * session-scoped state in the caller so it survives across the
	 * `tool_execution_update` → `tool_execution_end` sequence for one call.
	 */
	getMetaTerminalSent?: (toolCallId: string) => string | undefined;
	/** Records the cumulative output text just delivered for `toolCallId` (see `getMetaTerminalSent`). */
	setMetaTerminalSent?: (toolCallId: string, text: string) => void;
}

interface ContentArrayContainer {
	content?: unknown;
}

interface DetailsContainer {
	details?: unknown;
}

interface TypedValue {
	type?: unknown;
}

interface TextLikeContent extends TypedValue {
	text?: unknown;
}

interface TerminalIdContainer {
	terminalId?: unknown;
}

interface NoticesContainer {
	notices?: unknown;
}

interface BinaryLikeContent extends TypedValue {
	data?: unknown;
	mimeType?: unknown;
}

interface PathContainer {
	path?: unknown;
}

interface OldPathContainer {
	oldPath?: unknown;
}

interface NewPathContainer {
	newPath?: unknown;
}

interface CommandContainer {
	command?: unknown;
}

interface EvalCellContainer {
	cells?: unknown;
}

interface EvalCellLike {
	language?: unknown;
	title?: unknown;
	code?: unknown;
}

interface PatternContainer {
	pattern?: unknown;
}

interface QueryContainer {
	query?: unknown;
}

interface ErrorMessageContainer {
	errorMessage?: unknown;
}

interface MessageContainer {
	message?: unknown;
}

interface ResourceLinkLikeContent extends TypedValue {
	uri?: unknown;
	name?: unknown;
	title?: unknown;
	description?: unknown;
	mimeType?: unknown;
	size?: unknown;
}

interface BlobResourceLike {
	uri?: unknown;
	blob?: unknown;
	mimeType?: unknown;
}

interface TextResourceLike {
	uri?: unknown;
	text?: unknown;
	mimeType?: unknown;
}

interface EmbeddedResourceLikeContent extends TypedValue {
	resource?: unknown;
}

interface TextMessageLike {
	role?: unknown;
}

const ACP_TEXT_LIMIT = 4_000;

/**
 * Device name when the call is an `xd://` device dispatch riding the
 * read/write transport (`write xd://<tool>` executes the mounted tool,
 * `read xd://` is discovery). Returns `undefined` for plain file paths.
 */
function xdevDispatchDevice(toolName: string, args: unknown): string | undefined {
	if (toolName !== "write" && toolName !== "read") return undefined;
	const path = extractStringProperty<PathContainer>(args, "path");
	if (!path) return undefined;
	return parseXdUrl(path)?.name ?? undefined;
}

/** Whether a Hub call carries peer-to-peer coordination rather than process control. */
function isInternalHubMessageTool(toolName: string, args: unknown): boolean {
	let hubArgs = args;
	if (toolName !== "hub") {
		if (xdevDispatchDevice(toolName, args) !== "hub" || typeof args !== "object" || args === null) {
			return false;
		}
		const content = Reflect.get(args, "content");
		if (typeof content !== "string") return false;
		try {
			hubArgs = JSON.parse(content);
		} catch {
			return false;
		}
	}
	if (typeof hubArgs !== "object" || hubArgs === null) return false;
	const op = Reflect.get(hubArgs, "op");
	switch (op) {
		case "list":
		case "inbox":
			return true;
		case "send":
			return typeof Reflect.get(hubArgs, "to") === "string";
		case "wait":
			// A bare wait or an `ids` wait settles on background-job delivery,
			// whose snapshot IS the job result (hub.md) — keep those visible.
			// Only a peer-scoped wait (`from`, no jobs) is internal messaging.
			return typeof Reflect.get(hubArgs, "from") === "string" && Reflect.get(hubArgs, "ids") === undefined;
		default:
			return false;
	}
}

export function mapToolKind(toolName: string, args?: unknown): ToolKind {
	// An xd:// device write executes the mounted tool — "edit" would make ACP
	// clients render it as a file modification to a nonexistent path (and
	// auto-approve it under edit-tier policies). Reads stay "read": listing
	// devices or fetching docs is discovery.
	if (toolName === "write" && xdevDispatchDevice(toolName, args)) return "execute";
	switch (toolName) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "bash":
		case "shell":
		case "exec":
		case "eval":
			return "execute";
		case "grep":
		case "glob":
		case "ast_grep":
			return "search";
		case "web_search":
			return "fetch";
		case "todo":
			return "think";
		default:
			return "other";
	}
}

export function mapAgentSessionEventToAcpSessionUpdates(
	event: AgentSessionEvent,
	sessionId: string,
	options: AcpEventMapperOptions = {},
): SessionNotification[] {
	switch (event.type) {
		case "message_update":
			return mapAssistantMessageUpdate(event, sessionId, options);
		case "message_end":
			return mapAssistantMessageEnd(event, sessionId, options);
		case "tool_execution_start": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const update = buildToolCallStartUpdate(
				{
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					intent: event.intent,
					cwd: options.cwd,
				},
				options,
			);
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_update": {
			if (isInternalHubMessageTool(event.toolName, event.args)) return [];
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: "in_progress",
				rawOutput: event.partialResult,
			};
			// A meta-terminal call already got its (empty) terminal reference on
			// `tool_execution_start`; `content` has no incremental-append story for
			// it (see `wantsMetaTerminal`'s doc), but `partialResult` is the same
			// cumulative-so-far text a live terminal would show (see
			// `streamTailUpdates`/`eval.ts`'s `pushUpdate`), so mirror it into
			// `_meta.terminal_output` instead of leaving the terminal blank until
			// `tool_execution_end`. `buildMetaTerminalDelta` diffs against what was
			// already sent so a growing cumulative snapshot becomes an append-only
			// byte stream instead of duplicating everything shown so far.
			if (wantsMetaTerminal(event.toolName, options)) {
				const partialText = extractTerminalStreamText(event.partialResult);
				if (partialText) {
					const delta = buildMetaTerminalDelta(event.toolCallId, event.toolName, event.args, partialText, options);
					if (delta) {
						update._meta = {
							terminal_output: {
								terminal_id: event.toolCallId,
								data: delta,
							},
						};
					}
				}
			} else {
				const codeFence = shouldCodeFenceToolOutput(event.toolName);
				const content = mergeToolUpdateContent(
					buildToolStartContent(event.toolName, event.args),
					extractToolCallContent(event.partialResult, options, codeFence),
				);
				if (content.length > 0) {
					update.content = content;
				}
			}
			const locations = extractToolLocations(event.args, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			return [toSessionNotification(sessionId, update)];
		}
		case "tool_execution_end": {
			const args = getToolExecutionEndArgs(event, options);
			if (isInternalHubMessageTool(event.toolName, args)) return [];
			const update: SessionUpdate = {
				sessionUpdate: "tool_call_update",
				toolCallId: event.toolCallId,
				status: event.isError ? "failed" : "completed",
				rawOutput: event.result,
			};
			if (wantsMetaTerminal(event.toolName, options)) {
				// No live client-owned terminal exists for this call (see
				// `wantsMetaTerminal`), so report the final output through the
				// display-only terminal `_meta` convention instead of a fenced
				// text block — matches `claude-agent-acp`'s `terminal_output`/
				// `terminal_exit` shape, and (unlike a live terminal id) survives
				// `session/load` replay verbatim since it carries no client-owned
				// resource reference.
				// The terminal block itself can't render binary content (an eval
				// cell's `display()`ed image lands in `details.images`, not the raw
				// output stream) — Zed's `has_terminals` routes any tool call
				// carrying a `terminal` item exclusively through the terminal
				// renderer, but that only concerns *text* duplication; images are
				// otherwise unrepresented and must ride alongside it, not be
				// dropped for it.
				update.content = [
					terminalToolCallContent(event.toolCallId),
					...extractDetailsImageToolCallContent(event.result, options, []),
				];
				const finalOutput = extractTerminalStreamText(event.result) ?? extractReadableText(event.result) ?? "";
				const delta = buildMetaTerminalDelta(event.toolCallId, event.toolName, args, finalOutput, options);
				update._meta = {
					...(delta !== undefined ? { terminal_output: { terminal_id: event.toolCallId, data: delta } } : {}),
					terminal_exit: {
						terminal_id: event.toolCallId,
						exit_code: extractExitCode(event.result, event.isError),
						signal: null,
					},
				};
			} else {
				const codeFence = shouldCodeFenceToolOutput(event.toolName);
				const diffContent = extractDiffToolCallContent(event.result);
				// A successful diff already shows the change; the tool's own text echo
				// of the post-edit file (or an "applied" acknowledgement) just repeats
				// it as a near-duplicate block below the diff. Only add that echo back
				// when there's no diff, or the call partially failed — a per-file error
				// message isn't represented by any diff and would otherwise be lost.
				//
				// A partial failure's joined text echo still carries every succeeded
				// file's own ack line (e.g. "Updated foo.ts") alongside the failure —
				// re-adding all of it here would duplicate those already-diffed files'
				// content. Use only the per-file error text in that case instead of the
				// full joined echo.
				let resultContent: ToolCallContent[];
				if (diffContent.length > 0 && !event.isError) {
					const prunedText = extractPrunedEditPathsText(event.result);
					resultContent = prunedText
						? [...diffContent, textToolCallContent(codeFence ? fenceCodeBlock(prunedText) : prunedText)]
						: diffContent;
				} else if (diffContent.length > 0 && event.isError) {
					const failureText = extractEditFailureText(event.result);
					resultContent = failureText
						? [...diffContent, textToolCallContent(codeFence ? fenceCodeBlock(failureText) : failureText)]
						: diffContent;
				} else {
					resultContent = [...diffContent, ...extractToolCallContent(event.result, options, codeFence)];
				}
				const content = mergeToolUpdateContent(buildToolStartContent(event.toolName, args), resultContent);
				if (content.length > 0) {
					update.content = content;
				}
			}
			const locations = extractToolLocationsFromResult(event.result, options.cwd);
			if (locations.length > 0) {
				update.locations = locations;
			}
			const notifications = [toSessionNotification(sessionId, update)];
			const planUpdate = mapTodoResultToPlanUpdate(event);
			if (planUpdate) {
				notifications.push(toSessionNotification(sessionId, planUpdate));
			}
			return notifications;
		}
		case "todo_reminder": {
			const entries = event.todos.map(todo => ({
				content: todo.content,
				priority: "medium" as const,
				status: mapTodoStatus(todo.status),
			}));
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries })];
		}
		case "todo_auto_clear":
			return [toSessionNotification(sessionId, { sessionUpdate: "plan", entries: [] })];
		default:
			return [];
	}
}

function mapAssistantMessageUpdate(
	event: Extract<AgentSessionEvent, { type: "message_update" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}

	let sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
	let text: string;
	const progress = options.getMessageProgress?.(event.message);
	switch (event.assistantMessageEvent.type) {
		case "image_end":
			return [
				toSessionNotification(sessionId, {
					sessionUpdate: "agent_message_chunk",
					content: event.assistantMessageEvent.content,
					messageId: options.getMessageId?.(event.message),
				}),
			];
		case "text_delta":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "thinking_delta": {
			const block = event.assistantMessageEvent.partial?.content?.[event.assistantMessageEvent.contentIndex];
			if (block?.type === "thinking" && !canonicalizeMessage(block.thinking)) return [];
			sessionUpdate = "agent_thought_chunk";
			text = event.assistantMessageEvent.delta;
			if (text.length > 0 && progress) {
				progress.thoughtEmitted = true;
			}
			break;
		}
		case "done":
			if (progress?.textEmitted) {
				return [];
			}
			sessionUpdate = "agent_message_chunk";
			text = extractAssistantMessageText(event.assistantMessageEvent.message);
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		case "error":
			sessionUpdate = "agent_message_chunk";
			text = event.assistantMessageEvent.error.errorMessage ?? "Unknown error";
			// The surfaced error is the message's visible text: keeps the
			// message_end / agent_end fallbacks from emitting again.
			if (text.length > 0 && progress) {
				progress.textEmitted = true;
			}
			break;
		default:
			return [];
	}
	if (text.length === 0) {
		return [];
	}

	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate,
			content: { type: "text", text },
			messageId,
		}),
	];
}

function mapAssistantMessageEnd(
	event: Extract<AgentSessionEvent, { type: "message_end" }>,
	sessionId: string,
	options: AcpEventMapperOptions,
): SessionNotification[] {
	if (!isAssistantMessage(event.message)) {
		return [];
	}
	const progress = options.getMessageProgress?.(event.message);
	if (!progress || progress.textEmitted) {
		return [];
	}
	const text = extractAssistantMessageText(event.message);
	if (text.length === 0) {
		return [];
	}
	progress.textEmitted = true;
	const messageId = options.getMessageId?.(event.message);
	return [
		toSessionNotification(sessionId, {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
			messageId,
		}),
	];
}

function toSessionNotification(sessionId: string, update: SessionUpdate): SessionNotification {
	return { sessionId, update };
}

const todoStatusMap: Record<TodoStatus, "pending" | "in_progress" | "completed"> = {
	pending: "pending",
	in_progress: "in_progress",
	completed: "completed",
	abandoned: "completed",
	blocked: "pending",
};

function mapTodoStatus(status: TodoStatus): "pending" | "in_progress" | "completed" {
	return todoStatusMap[status];
}

function mapTodoResultToPlanUpdate(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
): SessionUpdate | undefined {
	if (event.toolName !== "todo" || event.isError) {
		return undefined;
	}
	const phases = extractTodoPhases(event.result);
	if (!Array.isArray(phases)) {
		return undefined;
	}
	return {
		sessionUpdate: "plan",
		entries: extractTodoEntries(phases).map(todo => ({
			content: todo.content,
			priority: "medium" as const,
			status: mapTodoStatus(todo.status),
		})),
	};
}

function extractTodoPhases(result: unknown): unknown {
	if (typeof result !== "object" || result === null || !("details" in result)) {
		return undefined;
	}
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null || !("phases" in details)) {
		return undefined;
	}
	return (details as { phases?: unknown }).phases;
}

function extractTodoEntries(phases: unknown[]): Array<{ content: string; status: TodoStatus }> {
	const entries: Array<{ content: string; status: TodoStatus }> = [];
	for (const phase of phases) {
		if (typeof phase !== "object" || phase === null || !("tasks" in phase)) {
			continue;
		}
		const tasks = (phase as { tasks?: unknown }).tasks;
		if (!Array.isArray(tasks)) {
			continue;
		}
		for (const task of tasks) {
			if (typeof task !== "object" || task === null || !("content" in task)) {
				continue;
			}
			const content = (task as { content?: unknown }).content;
			if (typeof content !== "string" || content.length === 0) {
				continue;
			}
			const status = (task as { status?: TodoStatus }).status;
			entries.push({ content, status: isTodoStatus(status) ? status : "pending" });
		}
	}
	return entries;
}

function isTodoStatus(status: unknown): status is TodoStatus {
	return (
		status === "pending" ||
		status === "in_progress" ||
		status === "completed" ||
		status === "abandoned" ||
		status === "blocked"
	);
}
export function buildToolCallStartUpdate(
	input: {
		toolCallId: string;
		toolName: string;
		args: unknown;
		intent?: string;
		cwd?: string;
		status?: "pending" | "completed";
	},
	options: AcpEventMapperOptions = {},
): SessionUpdate {
	const update: ToolCall & { sessionUpdate: "tool_call" } = {
		sessionUpdate: "tool_call",
		toolCallId: input.toolCallId,
		title: buildToolTitle(input.toolName, input.args, input.intent),
		kind: mapToolKind(input.toolName, input.args),
		status: input.status ?? "pending",
		rawInput: input.args,
	};
	if (wantsMetaTerminal(input.toolName, options)) {
		// Pre-register the display-only terminal under the tool call's own id
		// (see `wantsMetaTerminal`) so its output/exit can land later, on
		// `tool_execution_end`, purely through `_meta` — no live client-owned
		// terminal is ever created for this call.
		update.content = [terminalToolCallContent(input.toolCallId)];
		update._meta = {
			terminal_info: {
				terminal_id: input.toolCallId,
				...(input.cwd ? { cwd: input.cwd } : {}),
			},
		};
	} else {
		const content = buildToolStartContent(input.toolName, input.args);
		if (content.length > 0) {
			update.content = content;
		}
	}
	const locations = extractToolLocations(input.args, input.cwd);
	if (locations.length > 0) {
		update.locations = locations;
	}
	return update;
}

export function normalizeReplayToolArguments(value: unknown): { args: unknown } {
	if (typeof value !== "string") {
		return { args: value ?? {} };
	}
	try {
		const parsed: unknown = JSON.parse(value);
		return { args: parsed };
	} catch {
		return { args: value };
	}
}

function getToolExecutionEndArgs(
	event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>,
	options: AcpEventMapperOptions,
): unknown {
	if ("args" in event) {
		return (event as { args?: unknown }).args;
	}
	return options.getToolArgs?.(event.toolCallId);
}

function buildToolStartContent(toolName: string, args: unknown): ToolCallContent[] {
	// Command tools show the command as the tool call's title; content stays
	// empty until execution produces real output (a live terminal block, or a
	// fenced fallback), so nothing duplicates the title.
	if (isCommandToolName(toolName)) {
		return [];
	}
	if (toolName === "eval") {
		const text = buildEvalStartText(args);
		return text ? [textToolCallContent(text)] : [];
	}
	return [];
}

function commandText(args: unknown): string | undefined {
	return extractStringProperty<CommandContainer>(args, "command");
}

function buildEvalStartText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	if (cells.length === 0) {
		return undefined;
	}
	const lines: string[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const language = extractStringProperty<EvalCellLike>(cell, "language") ?? "?";
		const title = extractStringProperty<EvalCellLike>(cell, "title");
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) {
			continue;
		}
		lines.push(title ? `[${language}] ${title}` : `[${language}]`, code);
	}
	return lines.length > 0 ? limitText(lines.join("\n")) : undefined;
}

/**
 * The source code for one or more eval cells. For a single cell, this omits
 * `buildEvalStartText`'s `[lang] title` label line — that label is already
 * the tool call's own title/header (see `buildEvalTitle`), so repeating it
 * here would show it twice in a client that echoes this text. For multiple
 * cells, `buildEvalTitle` only lists the labels joined together
 * (`"[py] a, [js] b"`), which doesn't say which code block is which once
 * they're concatenated below — so each cell's own `[lang] title` line is
 * kept here to preserve that attribution.
 */
function buildEvalCodeText(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	const entries: { language: string; title: string | undefined; code: string }[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) continue;
		entries.push({
			language: extractStringProperty<EvalCellLike>(cell, "language") ?? "?",
			title: extractStringProperty<EvalCellLike>(cell, "title"),
			code,
		});
	}
	if (entries.length === 0) {
		return undefined;
	}
	const codeBlocks =
		entries.length === 1
			? [entries[0]!.code]
			: entries.map(
					entry => `${entry.title ? `[${entry.language}] ${entry.title}` : `[${entry.language}]`}\n${entry.code}`,
				);
	return limitText(codeBlocks.join("\n\n"));
}

/**
 * The final `terminal_output` payload for a meta-terminal tool call.
 * Zed's `render_any_tool_call` routes any tool call carrying a `terminal`
 * content item exclusively through its terminal renderer (see
 * `has_terminals` in `thread_view.rs`) — every other `content` item on the
 * same tool call is silently ignored, never shown "hidden until expanded"
 * as `buildEvalStartText`'s doc comment once assumed. `bash`/`shell`/`exec`
 * need no workaround: their title *is* the full command already. But
 * `eval`'s title is deliberately a short `[lang] cellTitle` label (see
 * `buildEvalTitle`), so its source has nowhere else to render — the only
 * remaining place is inside the terminal's own text stream, echoed ahead of
 * the real output like a shell echoing the command it's about to run.
 */
function buildTerminalMetaOutputData(toolName: string, args: unknown, output: string): string {
	if (toolName !== "eval") {
		return output;
	}
	const code = buildEvalCodeText(args);
	return code ? `${code}\n${"─".repeat(48)}\n${output}` : output;
}

/**
 * Length of the longest suffix of `sent` that is also a prefix of `next`,
 * i.e. how many trailing bytes of `sent` reappear at the start of `next`.
 *
 * Searches the *entire* retained `sent`/`next` window rather than a fixed
 * trial bound. A naive longest-candidate-first scan capped at some byte
 * count (to keep per-candidate `startsWith` trials affordable) misses
 * genuine overlap once a tail-buffer roll — 50 KB for bash, 100 KB for eval,
 * see `DEFAULT_MAX_BYTES` — exceeds that cap: `deliveredOverlap` then
 * returns 0, and the caller suppresses the rest of the stream including the
 * final `tool_execution_end` payload. Instead this runs in
 * O(sent.length + next.length) via the KMP failure function of
 * `next + "\0" + sent`: its last entry is the longest prefix of `next` that
 * is also a suffix of the combined string, which — since the separator byte
 * can never match either side — is exactly the longest suffix of `sent`
 * matching a prefix of `next`.
 */
function deliveredOverlap(sent: string, next: string): number {
	if (sent.length === 0 || next.length === 0) return 0;
	const combined = `${next}\u0000${sent}`;
	const failure = new Uint32Array(combined.length);
	for (let i = 1; i < combined.length; i++) {
		let j = failure[i - 1];
		while (j > 0 && combined[i] !== combined[j]) j = failure[j - 1];
		if (combined[i] === combined[j]) j++;
		failure[i] = j;
	}
	return failure[combined.length - 1];
}

/**
 * The `_meta.terminal_output` payload to emit for `cumulativeOutput`, or
 * `undefined` when there is nothing new to send. Diffs against the
 * previously-delivered text (see `AcpEventMapperOptions.
 * getMetaTerminalSent`) so a growing cumulative-so-far snapshot — the shape
 * both `tool_execution_update` and `tool_execution_end` carry — becomes an
 * append-only byte stream instead of resending everything already shown
 * (Zed treats `terminal_output.data` as bytes to append, never a
 * replacement). The one-time eval source header from
 * `buildTerminalMetaOutputData` is included only on the very first send for
 * this tool call, never repeated on later deltas.
 *
 * The recorded state is the raw producer bytes delivered so far, excluding the
 * one-time eval source header — every later snapshot from the producer is raw
 * (see `eval.ts`'s `pushUpdate`), so a header-prefixed watermark would never
 * match the fast `startsWith` path below. It is never the producer's latest
 * snapshot either, so a snapshot that regresses cannot make later deltas
 * re-send bytes already on screen.
 */
function buildMetaTerminalDelta(
	toolCallId: string,
	toolName: string,
	args: unknown,
	cumulativeOutput: string,
	options: AcpEventMapperOptions,
): string | undefined {
	const prior = options.getMetaTerminalSent?.(toolCallId);
	if (prior === undefined) {
		const first = buildTerminalMetaOutputData(toolName, args, cumulativeOutput);
		options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
		return first;
	}
	if (cumulativeOutput === prior) {
		return undefined;
	}
	if (cumulativeOutput.startsWith(prior)) {
		options.setMetaTerminalSent?.(toolCallId, cumulativeOutput);
		return cumulativeOutput.slice(prior.length);
	}
	// The snapshot is not an extension of what the client already appended.
	// `terminal_output.data` is append-only: delivered bytes can be neither
	// replaced nor erased, so re-sending the whole snapshot duplicates visible
	// output instead of resynchronizing. Two producers reach here legitimately —
	// an authoritative snapshot that is shorter than the live-streamed tail it
	// replaces, and a bounded tail buffer whose window rolled forward — so send
	// only the genuinely undelivered remainder, and keep the delivered text as
	// the watermark either way.
	if (prior.startsWith(cumulativeOutput)) {
		return undefined;
	}
	const overlap = deliveredOverlap(prior, cumulativeOutput);
	if (overlap === 0) {
		logger.warn("ACP terminal output snapshot diverged from delivered text; suppressing", {
			toolCallId,
			toolName,
			deliveredBytes: prior.length,
			snapshotBytes: cumulativeOutput.length,
		});
		return undefined;
	}
	const delta = cumulativeOutput.slice(overlap);
	if (!delta) {
		return undefined;
	}
	options.setMetaTerminalSent?.(toolCallId, prior + delta);
	return delta;
}

/**
 * Short label for the tool call's title/header, which a live-terminal-style
 * ACP client (Zed) renders unconditionally, never gated behind the
 * expand/collapse disclosure. Unlike `buildEvalStartText` (used for the
 * *content*, which the client does hide until expanded), this must stay
 * short: language + optional cell title, never the code itself — otherwise
 * the "hidden until expanded" code shows up twice, once unhideable as the
 * title.
 */
function buildEvalTitle(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		return undefined;
	}
	const container = args as EvalCellContainer & EvalCellLike;
	const cells = Array.isArray(container.cells)
		? container.cells
		: typeof container.code === "string"
			? [container]
			: [];
	if (cells.length === 0) {
		return undefined;
	}
	const labels: string[] = [];
	for (const cell of cells) {
		if (typeof cell !== "object" || cell === null || Array.isArray(cell)) {
			continue;
		}
		const language = extractStringProperty<EvalCellLike>(cell, "language") ?? "?";
		const title = extractStringProperty<EvalCellLike>(cell, "title");
		const code = extractStringProperty<EvalCellLike>(cell, "code");
		if (!code) {
			continue;
		}
		labels.push(title ? `[${language}] ${title}` : `[${language}]`);
	}
	return labels.length > 0 ? limitText(labels.join(", ")) : undefined;
}

function mergeToolUpdateContent(startContent: ToolCallContent[], resultContent: ToolCallContent[]): ToolCallContent[] {
	if (startContent.length === 0) {
		return resultContent;
	}
	const merged = [...startContent];
	for (const item of resultContent) {
		if (
			item.type === "content" &&
			item.content.type === "text" &&
			hasEquivalentTextContent(merged, item.content.text)
		) {
			continue;
		}
		merged.push(item);
	}
	return merged;
}

function isCommandToolName(toolName: string): boolean {
	return toolName === "bash" || toolName === "shell" || toolName === "exec";
}

/**
 * Whether this tool call should render via the display-only "meta terminal"
 * convention (`_meta.terminal_info`/`terminal_output`/`terminal_exit`, keyed
 * by the tool call's own id) instead of a live client-owned terminal or a
 * fenced text block. `eval` never spawns a live terminal, so it always
 * qualifies; `bash`/`shell`/`exec` only fall back to it when the live path
 * (`terminal/create`) is unavailable — no real terminal capability, or
 * `session/load` replay, where `realTerminalCapable` is forced `false`
 * because no live process exists to attach a new client terminal to. Gated
 * on `terminalMetaCapable` throughout: a client that doesn't understand the
 * convention must get the fenced-text fallback instead of a dangling,
 * unrenderable terminal reference.
 */
function wantsMetaTerminal(toolName: string, options: AcpEventMapperOptions): boolean {
	if (!options.terminalMetaCapable) return false;
	if (toolName === "eval") return true;
	return isCommandToolName(toolName) && options.realTerminalCapable !== true;
}

/**
 * `bash`/`shell`/`exec` only set `details.exitCode` on a nonzero exit (see
 * `#buildCompletedResult`) — a successful run's process really did exit 0,
 * it just isn't spelled out in the details object. Report that explicit 0
 * rather than leaving the terminal's exit status blank, but never guess a
 * number for an unattributed failure (wrong signal is worse than none).
 */
function extractExitCode(value: unknown, isError: boolean | undefined): number | undefined {
	if (typeof value === "object" && value !== null) {
		const details = (value as DetailsContainer).details;
		if (typeof details === "object" && details !== null) {
			const exitCode = (details as { exitCode?: unknown }).exitCode;
			if (typeof exitCode === "number") return exitCode;
		}
	}
	return isError ? undefined : 0;
}

/**
 * Whether a tool's output content should render as a fenced code block
 * rather than raw Markdown. Applies to command/eval output (handled by
 * their own title/terminal paths) and to tools whose output is code or
 * file/search data — a file's contents, a diff notice, a search hit list —
 * never natural-language prose. Deliberately excludes tools whose output is
 * meant to render as rich Markdown (subagent/task reports, web search hits,
 * Hub messages): fencing those would flatten formatting the tool intends.
 */
function shouldCodeFenceToolOutput(toolName: string): boolean {
	if (isCommandToolName(toolName) || toolName === "eval") return true;
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "delete":
		case "move":
		case "grep":
		case "glob":
		case "ast_grep":
			return true;
		default:
			return false;
	}
}

function buildToolTitle(toolName: string, args: unknown, intent: string | undefined): string {
	if (isCommandToolName(toolName)) {
		const command = commandText(args);
		if (command) return limitText(command);
	}
	if (toolName === "eval") {
		const evalTitle = buildEvalTitle(args);
		if (evalTitle) return evalTitle;
	}
	const trimmedIntent = intent?.trim();
	if (toolName === "edit") {
		// The edit tool's target path lives in a top-level `path` arg (patch/replace
		// modes) or is embedded in the `input` payload (hashline header / apply_patch
		// marker) — neither is caught by the generic path/command/pattern/query
		// subject fallback below, so a bare "edit" title (or the description alone,
		// with no file name at all) was all a client had to show.
		const editPath = extractEditPath(args);
		if (editPath) {
			return trimmedIntent ? `${trimmedIntent} — ${editPath}` : `Edit ${editPath}`;
		}
	}
	if (trimmedIntent) {
		return trimmedIntent;
	}

	const subject =
		extractStringProperty<PathContainer>(args, "path") ??
		extractStringProperty<CommandContainer>(args, "command") ??
		extractStringProperty<PatternContainer>(args, "pattern") ??
		extractStringProperty<QueryContainer>(args, "query");
	if (subject) {
		// Internal URLs (xd://github, skill://react, …) name their target fully;
		// prefixing the transport tool reads as a file write to a fake path.
		if (INTERNAL_URL_SUBJECT.test(subject)) return subject;
		return `${toolName}: ${subject}`;
	}

	return toolName;
}

/**
 * Resolve a single raw path against cwd for an ACP location. When `cwd` is
 * omitted we pass the value through unchanged (callers without session
 * context, e.g. some legacy entry points and tests); the ACP-side caller
 * always supplies cwd so notifications carry absolute paths.
 */
function toAcpLocationPath(value: string, cwd?: string): string {
	if (!cwd) return value;
	try {
		return resolveToCwd(value, cwd);
	} catch {
		return value;
	}
}

/**
 * Scheme-qualified subjects (`xd://`, `skill://`, `agent://`, `https://`, …)
 * are not local files: resolving them against cwd fabricates paths like
 * `/repo/xd:/github` and makes editors focus nonexistent files.
 */
const INTERNAL_URL_SUBJECT = /^[a-z][a-z0-9+.-]*:\/\//i;

function extractToolLocations(args: unknown, cwd?: string): ToolCallLocation[] {
	const locations: ToolCallLocation[] = [];
	const seen = new Set<string>();
	const pushPath = (raw: string | undefined) => {
		if (!raw || INTERNAL_URL_SUBJECT.test(raw)) return;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) return;
		seen.add(path);
		locations.push({ path });
	};

	pushPath(extractStringProperty<PathContainer>(args, "path"));
	pushPath(extractStringProperty<OldPathContainer>(args, "oldPath"));
	pushPath(extractStringProperty<NewPathContainer>(args, "newPath"));

	return locations;
}

/** Pull locations from a tool result's details (e.g. EditToolDetails.perFileResults[].path). */
function extractToolLocationsFromResult(result: unknown, cwd?: string): ToolCallLocation[] {
	if (typeof result !== "object" || result === null) return [];
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return [];
	const direct = extractToolLocations(details, cwd);
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	if (!Array.isArray(perFile)) {
		return direct;
	}
	const seen = new Set(direct.map(loc => loc.path));
	const locations = [...direct];
	for (const entry of perFile) {
		const raw = extractStringProperty<PathContainer>(entry, "path");
		if (!raw) continue;
		const path = toAcpLocationPath(raw, cwd);
		if (seen.has(path)) continue;
		seen.add(path);
		locations.push({ path });
	}
	return locations;
}

/** Emit a `diff` ToolCallContent for each per-file edit result that carries oldText/newText. */
function extractDiffToolCallContent(result: unknown): ToolCallContent[] {
	if (typeof result !== "object" || result === null) return [];
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return [];
	const blocks: ToolCallContent[] = [];
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	const entries: unknown[] = Array.isArray(perFile) ? perFile : [details];
	for (const entry of entries) {
		const block = buildDiffContent(entry);
		if (block) blocks.push(block);
	}
	return blocks;
}

/**
 * Join the per-file error messages from a partially-failed multi-file edit,
 * skipping succeeded entries, followed by which files were never attempted
 * (see `EditToolDetails.unattemptedPaths`) — mirrors the executor's own
 * `Files NOT applied: ...` guidance line so the ACP display can tell a
 * skipped-after-failure file apart from one that was never part of the edit.
 */
function extractEditFailureText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	if (!Array.isArray(perFile)) return undefined;
	const lines: string[] = [];
	for (const entry of perFile) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as {
			path?: unknown;
			isError?: unknown;
			errorText?: unknown;
			displayErrorText?: unknown;
		};
		if (candidate.isError !== true) continue;
		const message =
			(typeof candidate.displayErrorText === "string" && candidate.displayErrorText) ||
			(typeof candidate.errorText === "string" && candidate.errorText) ||
			undefined;
		if (!message) continue;
		const path = typeof candidate.path === "string" && candidate.path.length > 0 ? candidate.path : undefined;
		lines.push(path ? `Error editing ${path}: ${message}` : message);
	}
	if (lines.length === 0) return undefined;
	const unattemptedPaths = "unattemptedPaths" in details ? details.unattemptedPaths : undefined;
	if (Array.isArray(unattemptedPaths) && unattemptedPaths.length > 0) {
		const paths = unattemptedPaths.filter((p): p is string => typeof p === "string" && p.length > 0);
		if (paths.length > 0) {
			lines.push(
				`Files NOT applied: ${paths.join(", ")}; re-read the affected files and re-issue only the failed and unapplied files.`,
			);
		}
	}
	return lines.join("\n");
}

/**
 * Names of successfully-edited files whose `oldText`/`newText` were dropped
 * by {@link pruneOversizedEditSnapshots} once the multi-file aggregate budget
 * (`MAX_EDIT_SNAPSHOT_TEXT_CHARS`) ran out — see `snapshot-details.ts`. Early
 * entries keep their diff; a later entry in the same batch can lose its
 * snapshot despite editing the file just as successfully. `buildDiffContent`
 * then has nothing to render for it, so without this note the file
 * disappears from the ACP content entirely even though the edit succeeded.
 *
 * Only entries with no diff of their own are named here — a pruned entry
 * that still has room for its own snapshot never reaches this path.
 */
function extractPrunedEditPathsText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const details = (result as { details?: unknown }).details;
	if (typeof details !== "object" || details === null) return undefined;
	const perFile = (details as { perFileResults?: unknown }).perFileResults;
	if (!Array.isArray(perFile)) return undefined;
	const paths: string[] = [];
	for (const entry of perFile) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { path?: unknown; isError?: unknown; snapshotsPruned?: unknown };
		if (candidate.isError === true || candidate.snapshotsPruned !== true) continue;
		if (buildDiffContent(entry)) continue;
		if (typeof candidate.path === "string" && candidate.path.length > 0) paths.push(candidate.path);
	}
	if (paths.length === 0) return undefined;
	return `Also applied (diff omitted: file snapshot too large): ${paths.join(", ")}`;
}

function buildDiffContent(entry: unknown): ToolCallContent | undefined {
	if (typeof entry !== "object" || entry === null) return undefined;
	const candidate = entry as { path?: unknown; oldText?: unknown; newText?: unknown; isError?: unknown };
	if (candidate.isError === true) return undefined;
	const path = typeof candidate.path === "string" && candidate.path.length > 0 ? candidate.path : undefined;
	if (!path) return undefined;
	const oldText = typeof candidate.oldText === "string" ? candidate.oldText : undefined;
	const newText = typeof candidate.newText === "string" ? candidate.newText : undefined;
	if (oldText === undefined && newText === undefined) return undefined;
	return {
		type: "diff",
		path,
		oldText: oldText ?? null,
		newText: newText ?? "",
	};
}

function extractTerminalId(value: unknown): string | undefined {
	const direct = extractStringProperty<TerminalIdContainer>(value, "terminalId");
	if (direct) return direct;
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	return extractStringProperty<TerminalIdContainer>(details, "terminalId");
}

function terminalToolCallContent(terminalId: string): ToolCallContent {
	return { type: "terminal", terminalId };
}

function extractToolCallContent(value: unknown, options: AcpEventMapperOptions, codeFence: boolean): ToolCallContent[] {
	const richContent = extractStructuredToolCallContent(value, options, codeFence);
	const detailsImageContent = extractDetailsImageToolCallContent(value, options, richContent);
	const combinedContent = [...richContent, ...detailsImageContent];
	const terminalId = extractTerminalId(value);
	if (terminalId && (options.isTerminalLive?.(terminalId) ?? true)) {
		// A live terminal already renders the command and its output as code;
		// duplicating that as plain-text content gets markdown-rendered (`#`
		// lines read as headings) and hides the terminal's own collapse control
		// behind a redundant card. Keep non-text content (e.g. images) since
		// that isn't otherwise represented in the terminal. What the terminal
		// cannot show still surfaces here, unfenced: `details.notices` (exit
		// code, truncation marker, `[raw output: artifact://N]` pointer) and a
		// framework-level `errorMessage`/`message` note (e.g. "Permission
		// request cancelled") are not part of the raw command output.
		const nonTextContent = combinedContent.filter(item => !(item.type === "content" && item.content.type === "text"));
		const withTerminal = hasTerminalContent(nonTextContent, terminalId)
			? nonTextContent
			: [...nonTextContent, terminalToolCallContent(terminalId)];
		const notices = extractDetailsNotices(value);
		const content = notices ? [...withTerminal, textToolCallContent(notices)] : withTerminal;
		const directText = extractDirectText(value);
		if (!directText || hasEquivalentTextContent(content, directText)) {
			return content;
		}
		return [...content, textToolCallContent(directText)];
	}
	// The value's `content` blocks (if any) already went through `richContent`
	// above; re-deriving the same text from them as a "fallback" produces a
	// near-duplicate block that differs only in trailing whitespace (richContent
	// preserves it, `extractReadableText` trims it), so only fall back when
	// structured extraction found no text at all.
	if (combinedContent.some(item => item.type === "content" && item.content.type === "text")) {
		// A framework-level `errorMessage`/`message` note is not one of those
		// blocks, so it still surfaces beside them, unfenced — the same rule the
		// terminal branch above follows.
		const directText = extractDirectText(value);
		const duplicate =
			!directText ||
			hasEquivalentTextContent(combinedContent, directText) ||
			(codeFence && hasEquivalentTextContent(combinedContent, fenceCodeBlock(directText)));
		return duplicate ? combinedContent : [...combinedContent, textToolCallContent(directText)];
	}
	const fallbackText = extractReadableText(value);
	if (!fallbackText) {
		return combinedContent;
	}
	const fenced = codeFence ? fenceCodeBlock(fallbackText) : fallbackText;
	return [...combinedContent, textToolCallContent(fenced)];
}

function extractStructuredToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	codeFence: boolean,
): ToolCallContent[] {
	const blocks = getContentBlocks(value);
	if (!blocks) {
		return [];
	}

	const content: ToolCallContent[] = [];
	for (const block of blocks) {
		const toolCallContent = toToolCallContent(block, options, codeFence);
		if (toolCallContent) {
			content.push(toolCallContent);
		}
	}
	return content;
}

function getContentBlocks(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) {
		return value;
	}
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return undefined;
	}
	const content = (value as ContentArrayContainer).content;
	return Array.isArray(content) ? content : undefined;
}

function toToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	codeFence: boolean,
): ToolCallContent | undefined {
	const type = getContentType(value);
	if (!type) {
		return undefined;
	}

	switch (type) {
		case "text": {
			const text = extractStructuredText(value);
			if (!text) return undefined;
			return textToolCallContent(codeFence ? fenceCodeBlock(text) : text);
		}
		case "image":
		case "audio":
			return binaryToolCallContent(type, value, options);
		case "resource_link": {
			const uri = extractStringProperty<ResourceLinkLikeContent>(value, "uri");
			const name = extractStringProperty<ResourceLinkLikeContent>(value, "name");
			if (!uri || !name) {
				return undefined;
			}
			const resourceLinkContent: {
				type: "resource_link";
				uri: string;
				name: string;
				title?: string;
				description?: string;
				mimeType?: string;
				size?: number;
			} = {
				type: "resource_link",
				uri,
				name,
			};
			const title = extractStringProperty<ResourceLinkLikeContent>(value, "title");
			if (title) {
				resourceLinkContent.title = title;
			}
			const description = extractStringProperty<ResourceLinkLikeContent>(value, "description");
			if (description) {
				resourceLinkContent.description = description;
			}
			const mimeType = extractStringProperty<ResourceLinkLikeContent>(value, "mimeType");
			if (mimeType) {
				resourceLinkContent.mimeType = mimeType;
			}
			const size = extractNumberProperty<ResourceLinkLikeContent>(value, "size");
			if (size !== undefined) {
				resourceLinkContent.size = size;
			}
			return {
				type: "content",
				content: resourceLinkContent,
			};
		}
		case "resource": {
			const resource = extractEmbeddedResource(value);
			return resource
				? {
						type: "content",
						content: {
							type: "resource",
							resource,
						},
					}
				: undefined;
		}
		default:
			return undefined;
	}
}

function binaryToolCallContent(
	type: "image" | "audio",
	value: unknown,
	options: AcpEventMapperOptions,
): ToolCallContent | undefined {
	const data = extractStringProperty<BinaryLikeContent>(value, "data");
	const mimeType = extractStringProperty<BinaryLikeContent>(value, "mimeType");
	if (!data || !mimeType) {
		return undefined;
	}
	return {
		type: "content",
		content: {
			type,
			data: type === "image" ? (options.resolveImageData?.(data, mimeType) ?? data) : data,
			mimeType,
		},
	};
}

function extractDetailsImageToolCallContent(
	value: unknown,
	options: AcpEventMapperOptions,
	existing: ToolCallContent[],
): ToolCallContent[] {
	const images = extractDetailsImages(value);
	if (!images) {
		return [];
	}
	const seen = new Set(existing.map(imageContentKey).filter((key): key is string => key !== undefined));
	const content: ToolCallContent[] = [];
	for (const image of images) {
		const toolCallContent = binaryToolCallContent("image", image, options);
		const key = imageContentKey(toolCallContent);
		if (!toolCallContent || !key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		content.push(toolCallContent);
	}
	return content;
}

function extractDetailsImages(value: unknown): unknown[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	if (typeof details !== "object" || details === null) return undefined;
	const images = (details as { images?: unknown }).images;
	return Array.isArray(images) && images.length > 0 ? images : undefined;
}

function imageContentKey(value: ToolCallContent | undefined): string | undefined {
	if (value?.type !== "content" || value.content.type !== "image") {
		return undefined;
	}
	return `${value.content.mimeType}\u0000${value.content.data}`;
}

function extractEmbeddedResource(
	value: unknown,
): { uri: string; text: string; mimeType?: string } | { uri: string; blob: string; mimeType?: string } | undefined {
	if (typeof value !== "object" || value === null || !("resource" in value)) {
		return undefined;
	}

	const resource = (value as EmbeddedResourceLikeContent).resource;
	if (typeof resource !== "object" || resource === null) {
		return undefined;
	}

	const uri = extractStringProperty<TextResourceLike>(resource, "uri");
	if (!uri) {
		return undefined;
	}

	const text = extractStringProperty<TextResourceLike>(resource, "text");
	if (text) {
		const mimeType = extractStringProperty<TextResourceLike>(resource, "mimeType");
		return mimeType ? { uri, text, mimeType } : { uri, text };
	}

	const blob = extractStringProperty<BlobResourceLike>(resource, "blob");
	if (!blob) {
		return undefined;
	}
	const mimeType = extractStringProperty<BlobResourceLike>(resource, "mimeType");
	return mimeType ? { uri, blob, mimeType } : { uri, blob };
}

function textToolCallContent(text: string): ToolCallContent {
	return {
		type: "content",
		content: {
			type: "text",
			text,
		},
	};
}

function hasEquivalentTextContent(content: ToolCallContent[], text: string): boolean {
	return content.some(item => item.type === "content" && item.content.type === "text" && item.content.text === text);
}

function hasTerminalContent(content: ToolCallContent[], terminalId: string): boolean {
	return content.some(item => item.type === "terminal" && item.terminalId === terminalId);
}

/**
 * `details.notices`: notes a tool appended after its raw output (exit code,
 * wall time, truncation marker, `[raw output: artifact://N]` pointer). A client
 * terminal renders only the process byte stream, so these have to be re-emitted
 * beside it or they go out with the raw-output text block.
 */
function extractDetailsNotices(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as DetailsContainer).details;
	if (typeof details !== "object" || details === null) return undefined;
	const notices = (details as NoticesContainer).notices;
	if (!Array.isArray(notices)) return undefined;
	const lines = notices.filter((notice): notice is string => typeof notice === "string" && notice.length > 0);
	return lines.length > 0 ? normalizeText(lines.join("\n")) : undefined;
}

/**
 * The `content` array's text blocks joined verbatim — nothing else, and
 * deliberately *not* run through `normalizeText`/`limitText`.
 *
 * Unlike `extractReadableText`, this never falls back to serializing the whole
 * value as JSON, so an empty/no-text partial result (e.g. before a command has
 * printed anything) correctly yields `undefined` instead of a stringified
 * `{content:[],details:{}}` blob landing in a terminal.
 *
 * `ACP_TEXT_LIMIT` must not apply here. It bounds *text content blocks*, where
 * a head truncation plus `…` is a readable degradation; a meta-terminal stream
 * is append-only bytes, so clamping it silently freezes the terminal: every
 * snapshot past the limit truncates to the same 4000 chars, so
 * `buildMetaTerminalDelta` sees an unchanged snapshot and emits nothing —
 * losing the rest of the stream including the final `tool_execution_end`
 * payload. The producers already bound this text (`eval.ts` streams through a
 * `TailBuffer(DEFAULT_MAX_BYTES * 2)`, bash truncates and says so in its own
 * notices), `claude-agent-acp` sends `terminal_output` untruncated, and Zed
 * truncates for display on its own (`original_content_len` vs `content.len()`
 * in `thread_view.rs`).
 */
function extractTerminalStreamText(value: unknown): string | undefined {
	const blocks = getContentBlocks(value);
	if (!blocks) return undefined;
	const text = blocks
		.map(block => extractStringProperty<TextLikeContent>(block, "text"))
		.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
		.join("\n")
		.trim();
	return text.length > 0 ? text : undefined;
}

/**
 * A framework-level `text`/`errorMessage`/`message` field set directly on the
 * result object (not nested in a `content` block array). Distinct from the
 * raw command output a `content` array or a live terminal would carry, so
 * it's safe to surface even when a terminal is already showing that output.
 */
function extractDirectText(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const directText =
		extractStringProperty<TextLikeContent>(value, "text") ??
		extractStringProperty<ErrorMessageContainer>(value, "errorMessage") ??
		extractStringProperty<MessageContainer>(value, "message");
	return directText ? normalizeText(directText) : undefined;
}

function extractReadableText(value: unknown): string | undefined {
	if (typeof value === "string") {
		return normalizeText(value);
	}
	if (value instanceof Error) {
		return normalizeText(value.message);
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	const directText = extractDirectText(value);
	if (directText) {
		return directText;
	}

	const contentBlocks = getContentBlocks(value);
	if (contentBlocks) {
		const text = contentBlocks
			.map(block => extractStructuredText(block))
			.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
			.join("\n");
		if (text.length > 0) {
			return normalizeText(text);
		}
		if (hasBinaryContentBlock(contentBlocks)) {
			return undefined;
		}
	}
	if (extractDetailsImages(value)) {
		return undefined;
	}
	const serialized = safeJsonStringify(value);
	return normalizeText(serialized);
}

export function extractAssistantMessageText(value: unknown): string {
	if (typeof value !== "object" || value === null || !("content" in value)) {
		return "";
	}
	const content = (value as ContentArrayContainer).content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map(block => extractStructuredText(block))
		.filter((chunk): chunk is string => typeof chunk === "string" && chunk.length > 0)
		.join("\n");
}

function extractStructuredText(value: unknown): string | undefined {
	const text = extractStringProperty<TextLikeContent>(value, "text");
	if (!text) {
		return undefined;
	}
	return limitText(text);
}

function getContentType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		return undefined;
	}
	const type = (value as TypedValue).type;
	return typeof type === "string" ? type : undefined;
}

function hasBinaryContentBlock(blocks: unknown[]): boolean {
	return blocks.some(block => {
		const type = getContentType(block);
		return type === "image" || type === "audio";
	});
}

/**
 * The edit tool's target file path: a top-level `path` arg for patch/replace
 * modes, or embedded in the `input` payload for hashline (`[path#TAG]`
 * header) / apply_patch (`*** Update File: path`) modes. Mirrors
 * `extractApprovalPath` in `src/edit/index.ts` — kept local (rather than
 * imported) since that helper returns the sentinel `"(unknown)"` for the
 * approval-prompt use case, not `undefined`.
 */
function extractEditPath(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const input = extractStringProperty<{ input?: unknown }>(args, "input");
	if (input) {
		const hashlineMatch = /^\[([^#\r\n]+)(?:#[0-9a-fA-F]{4})?\]/m.exec(input);
		if (hashlineMatch?.[1]) return hashlineMatch[1];
		const applyPatchMatch = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/m.exec(input);
		if (applyPatchMatch?.[1]) return applyPatchMatch[1].trim();
	}
	return extractStringProperty<PathContainer>(args, "path");
}

function extractStringProperty<T extends object>(value: unknown, key: keyof T): string | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function extractNumberProperty<T extends object>(value: unknown, key: keyof T): number | undefined {
	if (typeof value !== "object" || value === null || !(key in value)) {
		return undefined;
	}
	const property = (value as T)[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function isAssistantMessage(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && "role" in value && (value as TextMessageLike).role === "assistant"
	);
}

function normalizeText(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? limitText(normalized) : undefined;
}

function limitText(text: string): string {
	return text.length > ACP_TEXT_LIMIT ? `${text.slice(0, ACP_TEXT_LIMIT - 1)}…` : text;
}

function safeJsonStringify(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/**
 * Wrap text in a Markdown fenced code block, widening the fence past any
 * run of backticks already present in the text so a command's own ``` output
 * can't prematurely close the fence. Used for command/eval output rendered
 * without a live terminal (no ACP terminal capability) so `#`-prefixed lines
 * (comments, Markdown-looking output) render as code, not headings.
 */
function fenceCodeBlock(text: string): string {
	let fence = "```";
	// A closing fence may be indented up to three spaces (CommonMark), so an
	// indented run of backticks closes the block just as a flush one does.
	for (const match of text.matchAll(/^ {0,3}`{3,}/gm)) {
		const run = match[0].trimStart();
		while (run.length >= fence.length) fence += "`";
	}
	return `${fence}\n${text}\n${fence}`;
}
