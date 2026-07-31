import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta";

function stringField(value: object, key: string): string | undefined {
	if (!(key in value)) return undefined;
	const candidate = (value as Record<string, unknown>)[key];
	return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Every string a producer recorded structurally for a renderer to surface,
 * shared by `test/acp-producer-wire.test.ts`'s matrix and
 * `test/acp-event-mapper.test.ts`'s `mapUpdates()` wrapper (rule 15/17).
 *
 * `details.notices`/`details.notice`/`details.meta`'s rendered notice are the
 * axes the matrix already declared; the top-level `errorMessage`/`message`/
 * `text` framework note (mirroring the mapper's own `extractDirectText`) is
 * the axis that had none — the eval image fallback dropped it in
 * `terminalMetaCapable` mode with no test anywhere asking whether it survived
 * (oh-my-pi/oh-my-pi#7078 review 4829715458).
 */
function artifactIds(text: string): string[] {
	return [...text.matchAll(/artifact:\/\/(\w+)/g)].map(m => m[1] as string);
}

export function producerFacts(result: AgentToolResult<unknown> | Record<string, unknown>): string[] {
	const facts: string[] = [];
	if (typeof result === "object" && result !== null) {
		const directText =
			stringField(result, "text") ?? stringField(result, "errorMessage") ?? stringField(result, "message");
		if (directText) facts.push(directText);
		const details = "details" in result ? (result as { details?: unknown }).details : undefined;
		if (typeof details === "object" && details !== null) {
			const noticeLines: string[] = [];
			if ("notices" in details) {
				const notices = (details as { notices?: unknown }).notices;
				if (Array.isArray(notices)) {
					for (const notice of notices) if (typeof notice === "string") noticeLines.push(notice);
				}
			}
			const single = stringField(details, "notice");
			if (single) noticeLines.push(single);
			facts.push(...noticeLines);
			if ("meta" in details) {
				const meta = (details as { meta?: OutputMeta }).meta;
				const metaNotice = meta ? formatOutputNotice(meta) : "";
				if (metaNotice) {
					// A spilled result can carry the same recovery pointer from two
					// independent subsystems — bash's own `[raw output: artifact://N]`
					// push (`details.notices`) and `OutputSink`'s elision summary
					// (`details.meta.truncation`) — in different wording. A real
					// producer never sets both for the *same* spill (bash's push is a
					// last-defense fallback that no-ops once the sink already spilled),
					// so requiring the meta wording verbatim on top of the notices
					// wording would demand two representations of one fact; the
					// mapper's own `extractTerminalNotices` already dedupes on shared
					// artifact ids, and this check only needs the underlying fact (the
					// artifact id) to survive once, not both phrasings.
					const coveredIds = new Set(artifactIds(noticeLines.join("\n")));
					const metaIds = artifactIds(metaNotice);
					const alreadyCovered = metaIds.length > 0 && metaIds.every(id => coveredIds.has(id));
					if (!alreadyCovered) facts.push(metaNotice);
				}
			}
		}
	}
	return facts.flatMap(fact =>
		fact
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0),
	);
}

/** Every text channel the client can actually render for this frame. */
export function frameTexts(update: Record<string, unknown>): string[] {
	const texts: string[] = [];
	if ("_meta" in update) {
		const meta = (update as { _meta?: { terminal_output?: { data?: unknown } } })._meta;
		if (typeof meta?.terminal_output?.data === "string") texts.push(meta.terminal_output.data);
	}
	const content = update.content;
	if (Array.isArray(content)) {
		for (const item of content) {
			if (typeof item !== "object" || item === null) continue;
			if ("type" in item && item.type === "content" && "content" in item) {
				const block = (item as { content?: { type?: unknown; text?: unknown } }).content;
				if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
			}
			if ("type" in item && item.type === "diff") {
				const newText = (item as { newText?: unknown }).newText;
				texts.push(typeof newText === "string" ? newText : "");
			}
		}
	}
	return texts;
}
