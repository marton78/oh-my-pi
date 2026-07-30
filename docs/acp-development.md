# ACP Development Guide

Rules for developing omp's Agent Client Protocol (ACP) integration
(`packages/coding-agent/src/modes/acp/`) — bug fixes, new capabilities, and protocol
feature adoption alike. Read this before touching ACP code.

## Rules

1. **Never guess the wire shape. Trace it.** Use [`acp-probe`](https://github.com/marton78/acp-probe)
   to capture real JSON-RPC frames before forming a theory. In-process tests construct
   `AcpAgent` directly against a fake client and cannot catch framing bugs,
   capability-gating bugs, or anything that only misbehaves once a real `initialize`
   handshake and interleaved JSON-RPC ids are involved.
2. **`claude-agent-acp` is the gold standard.** It is a real, working ACP server that Zed
   renders correctly. When the ACP spec/schema is silent on a rendering detail (title
   format, which content types combine, when to fence text as code) or on how a new
   protocol feature is expected to be used, match what `claude-agent-acp/src/tools.ts`
   (and `src/acp-agent.ts`) does — do not invent a "nicer" shape or a novel usage pattern.
   See acp-probe's README for the frame-diffing workflow against it.
3. **Diff the actual frames, not the code path you assume runs.** Read the emitted
   `session/update` / `session/request_permission` JSON, not just the mapper source.
   Content arrays can look correct on inspection and still be wrong on the wire (e.g. an
   extra content item nobody meant to add).
4. **If `acp-probe` is missing something you need, extend it upstream.** It's a separate
   project (https://github.com/marton78/acp-probe), not vendored here — file the
   subcommand/flag/capability-toggle addition there (see its own `AGENTS.md`) rather than
   working around the gap locally or forking it into this repo.
5. **After any edit, `git diff --stat` before trusting it.** Formatters in this repo
   (`bunx biome format --write`, and even the plain edit tool) have reflowed entire
   `*.test.ts` files from tabs/120-col to 2-space/80-col, including untouched regions,
   despite `biome.json` specifying tabs. A 2-line logical change showing as a 400-line
   diff means the formatter clobbered the file — revert and reapply the substance only
   (exact string search-and-replace + raw write), never trust "it looked fine in the
   diff view."
6. **ACP surface changes MUST be smoke-tested with the probe, in addition to unit tests.**
   "ACP surface" means `modes/acp/`, `commands/acp.ts`, or anything only reachable through
   the real JSON-RPC handshake — new capabilities, new tool-call mappings, new session
   updates, and bug fixes alike. Run `acp-probe <subcommand>` (see below) as well as
   `test/acp-*.test.ts`. The in-process tests construct `AcpAgent` directly against a fake
   client and never cross a real stdio transport, so they cannot catch framing bugs,
   stdout pollution, or capability gating that only misbehaves once a real `initialize`
   handshake and interleaved JSON-RPC ids are involved.
7. **A gate/invariant violation is a class of bug, not an instance — and this one is now
   enforced, not just documented.** `has_terminals` (`thread_view.rs`) hides *every*
   sibling `content` item for *any* terminal-bearing tool call, live or meta.
   `AcpAgent#sendUpdate` (`acp-agent.ts`) is the single chokepoint every outbound
   `session/update` passes through; it runs `assertAcpUpdateInvariants`
   (`acp-update-invariants.ts`), which fails (throws under `bun test`, logs otherwise)
   any frame whose `content` carries a terminal item alongside a sibling. It checks the
   *finished* frame, so it catches violations assembled from merged/dynamically-built
   content — not just literal array shapes a static search could see — including in
   code paths not yet written. If you add a new execute-kind tool or a new
   `content`-merging branch, this is your safety net, not a substitute for still
   getting the shape right: a violation here means the same content a user would have
   silently lost is now a loud, immediate test failure instead of something a reviewer
   has to notice by eye.

8. **New incremental/derived stream state ships with its own boundary test in the
   commit that introduces it.** Watermarks, overlap/resync scans, delta encoders —
   anything that accumulates or compares across updates — needs a test at the
   boundary that breaks a naive implementation (overlap larger than your scan
   window, growth across many updates past any single producer's buffer cap) before
   you open the PR, not after a reviewer's stress case finds it. (PR #7078 shipped
   both a >4096-byte overlap-scan cap and an unbounded watermark-growth bug this way,
   each caught in a later round of the same review.)
9. **Every `_meta.terminal_*` write goes through `buildTerminalMeta`
   (`acp-event-mapper.ts`) — there is no other write site.** It returns `undefined`
   unless `options.terminalMetaCapable`, so an ungated `_meta.terminal_*` emission
   isn't just discouraged, it's unwritable: build the object through it instead of a
   literal `{ terminal_output: {...} }`. `assertAcpUpdateInvariants` (rule 7's guard)
   additionally fails any frame carrying a `_meta.terminal_*` key when the client never
   negotiated the capability, so a stray direct-literal write outside the builder — or
   any future ad hoc `_meta.*` extension gated on a different capability — is still
   caught at the emit chokepoint even if it bypasses `buildTerminalMeta` entirely. For a
   brand-new `_meta.*` extension unrelated to the terminal convention, add its own gate
   check to `checkAcpUpdateInvariants` rather than assuming rule 7's guard covers it.
10. **A tool's `tool_execution_end` result is not always a raw continuation of
   what `tool_execution_update` streamed — check before feeding it to a delta
   diff.** `buildMetaTerminalDelta`/`buildFinalMetaTerminalDelta`
   (`acp-event-mapper.ts`) assume the text handed in is more of the same
   append-only byte stream. Several producers hand back a *display
   re-render* instead: `eval.ts` trims leading/trailing whitespace off its
   final output, per-line truncation past `tools.maxColumn` (768 chars by
   default), or head/tail spill elision past the artifact threshold. There
   is no enumerable list of every normalization a producer might apply, and
   diffing a re-render against the raw watermark via `deliveredOverlap` can
   find a false zero (or spuriously small, on self-similar bytes) overlap
   and fire the rollover-resync branch even though nothing was lost — a
   false `discontinuity` notice plus a duplicate re-send of already-delivered
   bytes. `buildFinalMetaTerminalDelta` instead uses a structural invariant:
   a display re-render can only shrink or preserve what already streamed,
   never exceed it, so a final snapshot no longer than the watermark is
   never diffed byte-for-byte — only genuinely new facts (`details.notices`)
   ride through. Any future producer-side reformatting of a final result is
   covered by this length check for free; it does not need a new marker.

## Running the probe against omp

[`acp-probe`](https://github.com/marton78/acp-probe) is a standalone tool, not vendored in
this repo. Install it once (`git clone` + `bun link` for a global `acp-probe` binary, or
run it in place with `bun run src/acp-probe.ts`). It has no default agent — point it at
omp explicitly:

```bash
acp-probe prompt "Run \`echo hi\` using the bash tool" \
  --cmd packages/coding-agent/scripts/omp --terminal --log /tmp/frames.log
grep -n "tool_call" /tmp/frames.log
```

`--cmd` **must** be a single executable, not a shell command string — `acp-probe` spawns
it directly (`Bun.spawn([cmd, ...args])`, no shell parsing), so
`ACP_PROBE_CMD="bun packages/coding-agent/src/cli.ts"` fails with `ENOENT` (the whole
string is looked up as one path). `scripts/omp` is the tracked dev launcher — point
`--cmd`/`$ACP_PROBE_CMD` at it directly; the default (non-`--no-subcommand`) mode already
appends `acp` as the child's first argument, so don't also pass `--arg acp`. Other agents
take `--no-subcommand` instead (see acp-probe's README). Full subcommand/flag reference,
and how to diff against `claude-agent-acp` as a rendering reference, live there — this doc
only covers what's specific to omp.

`--isolate` hides your real credentials (throwaway `XDG_*`/`PI_CODING_AGENT_DIR` state), so
a `prompt` there usually fails with `RequestError: Internal error (code=-32603)` plus a
`data: {"details":"No model selected. Use /login, ..."}` line — that's the probe correctly
reporting a real auth failure, not a probe bug; use `--isolate` for handshake/session
probing only, never for a `prompt` that needs to actually reach a model.

For rules 7–10's boundary/regression classes specifically, `acp-probe stress-output
<bytes>` and `acp-probe kill-mid-tool <text...>` exercise them directly against a real
`omp acp` process instead of by hand — see acp-probe's README for both.

Frame logs are the source of truth. Read the literal `content` array, `title`, and `kind`
sent for the tool call you're working on before changing (or writing) any mapper code.

## Adding a new ACP feature

- Check whether `claude-agent-acp` already implements it — if so, its shape is the
  contract, not the ACP schema's minimum requirement.
- Check `agent-client-protocol/schema` and the TS/Rust SDKs (`acp-ts-sdk`,
  `acp-rust-sdk`) for the current wire types before hand-writing JSON shapes.
- Gate new capabilities behind the client's advertised `clientCapabilities` at
  `initialize` — never assume a capability is present.
- If exercising the new feature needs a probe subcommand/flag that doesn't exist yet, add
  it upstream in `acp-probe` (rule 4) so it's reproducible without a real editor.
- Land unit test coverage in `test/acp-*.test.ts` alongside probe verification — neither
  replaces the other (see rule 6).

## Do

- Match `claude-agent-acp`'s exact content-array composition per tool kind (e.g. a live
  terminal's content is `[{type: "terminal", terminalId}]` **exclusively** — never mixed
  with a text echo of the same command/output).
- A terminal-bearing tool call's `content` array is a dead letterbox for anything
  besides the terminal item itself in the live card: Zed's `has_terminals`
  (`thread_view.rs`) renders it *exclusively* through the terminal renderer,
  silently dropping every sibling `content` item (text, including a framework-level
  `errorMessage`) from what the user sees while working. Those sibling items only
  resurface via "Copy as Markdown"/thread export (`ToolCall::to_markdown`, which
  walks `content` unconditionally) — never rely on them for live-card UX. For a
  real, client-owned terminal, deliver extra facts (exit code, truncation, an
  artifact pointer) by appending `_meta.terminal_output` bytes keyed by that
  *same* terminal id instead — Zed's `on_terminal_provider_event`
  (`agent_servers/acp.rs`) writes `terminal_output` straight into whatever
  terminal buffer already owns that id, real or display-only, so it renders in
  the live card and the markdown export identically, with no duplicate delivery
  path to keep in sync (see `buildLiveTerminalNoticeMeta` in
  `acp-event-mapper.ts`).
- Wrap command/tool output in a fenced code block (` ```lang ... ``` `) whenever a client
  might lack terminal support and would otherwise render raw output as Markdown (`#` lines
  becoming headings, etc.).
- Verify both the terminal-capable path (`--terminal`) and the fallback path for any
  execute-kind tool change.
- Check `test/acp-*.test.ts` for existing coverage of the exact behavior you're changing;
  update it in the same commit as the mapper change, not after.
- Rebuild your mental model of "what Zed does with this" from the reference implementation
  or a live Zed session — never from assumption.
- For any execute-kind tool call with no live client-owned terminal behind it (`eval`
  always; `bash`/`shell`/`exec` whenever `terminal/create` isn't available — no real
  terminal capability, or `session/load` replay, where no live process exists to attach a
  new client terminal to), use the display-only terminal `_meta` convention instead of a
  fenced text block: `_meta.terminal_info = {terminal_id, cwd}` on the tool call's
  `pending` start (with `content: [{type: "terminal", terminalId}]` keyed by the tool
  call's own id — never a real, connection-specific terminal id, which is meaningless
  after `session/load`), then `_meta.terminal_output = {terminal_id, data}` and
  `_meta.terminal_exit = {terminal_id, exit_code, signal}` on the final
  `tool_call_update`. This is Zed's own ad hoc v1 extension (see
  `crates/agent_servers/src/acp.rs`'s `handle_session_notification`, which builds a
  `TerminalBuilder::new_display_only` terminal purely from this `_meta`, no RPC
  involved) and exactly what `claude-agent-acp` does for its local Bash tool
  (`toolInfoFromToolUse`/`toolUpdateFromToolResult` in `src/tools.ts`). Gate it on
  `clientCapabilities._meta.terminal_output === true` (`AcpEventMapperOptions.
  terminalMetaCapable` in `acp-event-mapper.ts`) — a client that doesn't understand the
  convention must get the fenced-text fallback instead of a dangling terminal reference.
  Because it's pure data (no client-owned resource), it renders identically whether
  streamed live or replayed from a persisted transcript — unlike the real
  `terminal/create` path, whose ids die with the connection.

## Don't

- Don't rely on `mapAgentSessionEventToAcpSessionUpdates` unit tests alone as proof a
  wire-level change works — always confirm with `acp-probe`.
- Don't run `packages/coding-agent/scripts/build-binary.ts` to "refresh" `~/.bun/bin/omp`
  for manual testing. `scripts/omp` is a tracked ~1.5KB **dev launcher shell script** (not
  a binary) that always `exec`s `bun ... src/cli.ts` from live source — it's already
  fresh. Running `build-binary.ts` overwrites it with a 126MB compiled binary as a side
  effect, which then shows up as a spurious, huge git diff. If you truly need the compiled
  binary, build it and point `acp-probe --cmd` at `dist/omp` explicitly; never let it land
  on top of `scripts/omp`.
- Don't add a second content item that duplicates information the client can already
  render (a terminal block plus a text echo of the same output, or two near-identical text
  blocks that differ only in trailing whitespace from different extraction paths — check
  both `extractStructuredToolCallContent` and the `extractReadableText` fallback aren't
  both firing on the same source).
- Don't trust `git diff --stat` silence — actually run it before committing. If a formatter
  reflowed a file you touched, `git checkout` it and reapply your change via exact
  string-replace, not another format pass.
- Don't commit build artifacts (`dist/`, `.bun-build` cache files, `scripts/omp` binary
  swaps) that appear from running build/dev scripts during debugging.
