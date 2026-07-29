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

## Running the probe against omp

[`acp-probe`](https://github.com/marton78/acp-probe) is a standalone tool, not vendored in
this repo. Install it once (`git clone` + `bun link` for a global `acp-probe` binary, or
run it in place with `bun run src/acp-probe.ts`). It has no default agent — point it at
omp explicitly:

```bash
ACP_PROBE_CMD="bun packages/coding-agent/src/cli.ts" \
  acp-probe prompt "Run \`echo hi\` using the bash tool" --arg acp --terminal --log /tmp/frames.log
grep -n "tool_call" /tmp/frames.log
```

`--arg acp` supplies omp's own subcommand convention (`bun .../cli.ts acp`); other agents
take `--no-subcommand` instead (see acp-probe's README). Full subcommand/flag reference,
and how to diff against `claude-agent-acp` as a rendering reference, live there — this doc
only covers what's specific to omp.

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
- Treat `terminal`-bearing content as exclusive of duplicate text; only add non-duplicate,
  out-of-band facts (e.g. a framework-level `errorMessage` not shown by the terminal)
  alongside it.
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
