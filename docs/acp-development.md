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
   enforced, not just documented — but only for the client it actually applies to.**
   `has_terminals` (`thread_view.rs`) hides *every* sibling `content` item for *any*
   terminal-bearing tool call, live or meta, but that renderer quirk belongs to a Zed
   client that negotiated `clientCapabilities._meta.terminal_output`
   (`agent_servers/acp.rs` always sets it); the ACP schema itself imposes no such
   exclusivity, so the mapper's best-effort sibling-content fallback for a client that
   *hasn't* negotiated the extension is legitimate, not a bug. `AcpAgent#sendUpdate`
   (`acp-agent.ts`) is the single chokepoint every outbound `session/update` passes
   through; it runs `assertAcpUpdateInvariants` (`acp-update-invariants.ts`), which
   fails (throws under `bun test`, logs otherwise) any frame whose `content` carries a
   terminal item alongside a sibling **when `context.terminalMetaCapable` is true** —
   gated, not unconditional, so it never flags the fallback branch it's meant to leave
   alone. It checks the *finished* frame, so it catches violations assembled from
   merged/dynamically-built content — not just literal array shapes a static search
   could see — including in code paths not yet written. If you add a new
   execute-kind tool or a new `content`-merging branch, this is your safety net, not a
   substitute for still getting the shape right: a violation here means the same
   content a user would have silently lost is now a loud, immediate test failure
   instead of something a reviewer has to notice by eye. **The guard only earns that
   claim if the tests you write actually call it** — mapper-level tests that call
   `mapAgentSessionEventToAcpSessionUpdates` directly bypass `#sendUpdate` entirely, so
   `packages/coding-agent/test/acp-event-mapper.test.ts`'s `mapUpdates()` wrapper runs
   `checkAcpUpdateInvariants` on every frame the suite builds, not just the ones that
   happen to flow through a real `AcpAgent` (oh-my-pi/oh-my-pi#7078 review 4821242767:
   a violating `[terminal, content]` frame shipped, and two tests pinned it as correct,
   because nothing in that 90-test suite ever ran the guard).

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
   literal `{ terminal_output: {...} }`. `assertAcpUpdateInvariants` additionally fails
   any frame carrying a `_meta.terminal_*` key when the client never negotiated the
   capability — unconditionally, unlike rule 7's terminal-sibling check, since an
   unnegotiated `_meta` key is meaningless to every client regardless of whether it
   also happens to be terminal-capable — so a stray direct-literal write outside the
   builder, or any future ad hoc `_meta.*` extension gated on a different capability,
   is still caught at the emit chokepoint even if it bypasses `buildTerminalMeta`
   entirely. For a brand-new `_meta.*` extension unrelated to the terminal convention,
   add its own gate check to `checkAcpUpdateInvariants` rather than assuming this one
   covers it.
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
   bytes. A re-render that shrinks or preserves length is never diffed
   byte-for-byte — only genuinely new facts (`details.notices`) ride
   through. A re-render can also *grow*: `eval` substitutes `(no output)`
   for an all-whitespace stream, and a failed cell appends a synthesized
   `Command exited with code N` suffix. Growth is therefore not itself
   proof of a genuine continuation — it's classified by `deliveredOverlap`
   finding a real suffix/prefix boundary, or (past the producer's own
   tail-buffer window) `isDisplayReRendered`'s positive marker from the
   producer's own `details.meta`, per rule 16. A future producer-side
   reformatting is covered by this length-plus-marker check for free; it
   does not need a new marker of its own unless it can *both* grow past the
   window *and* leave no overlap with what streamed, which is exactly what
   rule 16 closes.
11. **A guard has to run where the frames it guards are built and tested,
   or it enforces nothing.** `assertAcpUpdateInvariants` runs at
   `AcpAgent#sendUpdate`, one layer above the mapper — but the bulk of ACP
   frame coverage calls `mapAgentSessionEventToAcpSessionUpdates` directly
   and never reaches that chokepoint. A `[terminal, content]` frame that
   the guard rejects still shipped, with two mapper tests pinning it as
   correct, because nothing in that suite ever ran the guard on the frames
   it built (oh-my-pi/oh-my-pi#7078 review 4821242767). Adding an
   enforcement mechanism is only half the fix: the tests that exercise the
   code the mechanism protects have to call it too, or "235 tests enforce
   this for free" is a claim, not a fact — verify it by deliberately
   feeding the guard a known-violating frame from within the suite that's
   supposed to catch it, not by reading the mechanism's own comment.
12. **A fact that lives only in a tool's own text or `details.meta` is
   invisible to the terminal-content path — re-derive it structurally, once,
   at the point notices are collected.** The terminal path (`content:
   [{type: "terminal", ...}]`, live or the display-only meta-terminal
   convention) never surfaces a tool's ordinary text content or reads
   `details.meta` directly; it only reads `details.notices`. `bash.ts`'s own
   `[raw output: artifact://N]` push into `details.notices` is a
   final-defense fallback that no-ops on the common path (`OutputSink`
   already spilled under the inline cap), so the truncation/recovery
   acknowledgement that *does* exist — in the tool's text and
   `details.meta.truncation` — silently never reached a terminal-rendering
   client. `extractTerminalNotices` (`acp-event-mapper.ts`) folds
   `details.meta`'s notice (via the same `formatOutputNotice` the edit
   branches already use) into every notice-delivery point instead of
   trusting a producer's own `details.notices` push to be complete.
13. **A one-time header that only one branch composes today will get lost by
   the next branch that doesn't — brand the payload so a hand-rolled literal
   is a type error, and add a stream-level guard for what a per-frame check
   structurally cannot see.** `eval`'s source code has exactly one rendered
   channel per tool call — meta-terminal bytes if the terminal survives to
   the final frame, plain `content` text if it doesn't (see
   `buildMetaTerminalOutput`'s doc comment in `acp-event-mapper.ts`) — because
   its title is deliberately a short `[lang] cellTitle` label with nowhere
   else for the source to go. Both known losses of it were a call site
   hand-rolling `{terminal_id, data}` instead of composing through the one
   function that knows to prepend the header on first send: the
   `session/load` dangling-call cleanup in `acp-agent.ts`
   (oh-my-pi/oh-my-pi#7078 review 4823843361) and the eval-image fallback in
   `acp-event-mapper.ts`, each on a different round of the same review.
   `MetaTerminalOutput` is now a nominally branded type — the brand symbol is
   module-private, so an inline literal fails `check:ts` instead of merely
   being discouraged, the same enforcement rule 9 already applies to an
   ungated `_meta.terminal_*` key. But the payload's *body* being correct is
   a cross-frame property no single-frame check can express: the header can
   legitimately ride on whichever frame is first in the sequence, so a check
   that only ever sees one frame at a time has no way to fail a sequence that
   never sends the header at all — which is exactly the class of bug that
   shipped, twice, since `checkAcpUpdateInvariants` passed both violating
   frames.  `EvalSourceDeliveryAuditor` (`acp-update-invariants.ts`)
   accumulates `_meta.terminal_output.data` and `content` text per tool call
   across the whole sequence and checks once, when the call reaches a
   terminal status, that the source it was expected to echo landed somewhere
   — wired into both `acp-event-mapper.test.ts`'s `mapUpdates()` wrapper and
   `acp-agent.test.ts`'s replay tests, so both the mapper suite and the
   suite that actually exercises `#replaySessionHistory` enforce it. A
   stateful, sequence-level guard is the general shape for this class:
   whenever "does X ever happen across N frames for the same call" can't be
   answered by looking at one frame, the guard needs the same per-call
   accumulation, not a bigger single-frame check.

   This complements, not replaces, rule 8's fixture requirement: the
   regression test for the dangling-cleanup bug originally used
   `input: { cells: [] }`, an eval with no source at all —
   `buildEvalCodeText` degenerates to `undefined` for it, so neither the bug
   nor the auditor's expectation could ever fire no matter which shape
   shipped, and the test passed either way. **A fixture that degenerates the
   feature under test converts an omission into a passing assertion — pick
   fixture data specific enough that the behavior being tested can actually
   fail**, the same lesson as review 4821242767's hand-fabricated
   `details.notices` (rule 12) applied to input shape instead of output
   shape.
14. **A tool's failure can live somewhere other than the result-level
    `isError` flag — derive the ACP status and the terminal's exit code from
    the same place, or one of them will lie.** `eval` records a nonzero-exit
    cell in `details.isError` plus `details.cells[].exitCode` and never calls
    `.error()` on its result builder, so `tool_execution_end.isError` is
    `false` for a call whose own output text says `Command exited with code 1`
    (oh-my-pi/oh-my-pi#7078 review 4823986869: the frame shipped
    `status: "completed"` and a synthesized `_meta.terminal_exit.exit_code:
    0`, i.e. a success check above a terminal that says the command failed).
    `toolResultFailed` (`tools/tool-result.ts`) is now the *only* failure
    derivation, shared by the ACP mapper (`isFailedToolResult`) and the TUI
    renderers that each used to hand-roll `result.isError ?? details.isError`
    (`edit/renderer.ts`, `mcp/render.ts`) — a producer that can only mark its
    failure inside `details` reaches every renderer at once instead of
    whichever one remembered the fallback. `extractExitCode` reads the failing
    cell's own code, but never invents one (an aborted eval has no exit code
    anywhere, and a wrong code is worse than none). Because the card's status
    and its terminal's exit line are two derivations of one result that a user
    reads together, `checkAcpUpdateInvariants` now fails any frame pairing
    `status: "completed"` with a nonzero `_meta.terminal_exit.exit_code`;
    the reverse pairing stays legal, since a tool can fail for reasons no
    process exit status expresses. **A fixture that only ever exercises the
    success path can't catch this** — every eval fixture in
    `acp-event-mapper.test.ts` had `exit_code: 0`, so nothing asked what a
    failing eval reports. The producer-seam test (`acp-producer-wire.test.ts`,
    rule 12's mechanism) is what caught it: a real `EvalTool.execute()` with a
    nonzero-exit backend, fed straight into the mapper.
15. **The producer matrix, not one case per bug: a tool result's facts are only
    real if a real producer put them there.** Every ACP finding in this PR's
    review had the same shape — the mapper read field X, the producer recorded
    the fact in field Y (or discarded it), and ~90 mapper tests fabricated X by
    hand so nothing could notice. `acp-producer-wire.test.ts` is therefore a
    table: each row runs a real tool through `wrapToolWithMetaNotice` (as
    production does) into the mapper, in each capability mode, and every row
    gets the same three checks — the hand-declared status/exit code for what
    the command actually did; **no fact the producer recorded structurally
    (`details.notices`, `details.notice`, `details.meta`'s rendered notice) is
    missing from the frame**; and `checkAcpUpdateInvariants` passes. That
    second check is the general form of the artifact-pointer loss (rule 12) and
    caught two further instances by itself: notices sitting past
    `ACP_TEXT_LIMIT`'s head truncation on the plain-content path, and a
    client-terminal timeout whose thrown `ToolError` dropped `details`
    entirely (`buildToolErrorResult` in `cursor.ts` builds a result with no
    `details` at all — a producer that throws instead of returning an error
    *result* loses every structurally-recorded fact, so bash's bridge timeout
    now returns one, matching its non-bridge path). Adding a producer outcome
    is one table row; adding a new tool with details-only facts means adding
    its row in the same commit.
16. **Replay the producer's own update stream, not just its final result — and
    treat the terminal as what it is: an append-only buffer.** A matrix row
    that feeds only `tool_execution_end` leaves `getMetaTerminalSent` empty, so
    every frame takes the first-send path and none of the delta/watermark code
    — the densest source of findings in this subsystem — ever runs. Each row
    now replays every `onUpdate` snapshot the real producer emitted through the
    mapper with a live watermark (as `AcpAgent` does), in a `meta` capability
    mode the matrix originally lacked entirely (`terminalMetaCapable` without a
    real terminal: `eval` always, `pty: true`, `session/load` replay), and adds
    two sequence-level checks a single frame cannot express:
    - **append-only**: no delivery may repeat a substantial run of bytes
      already sent for that terminal id, because a client concatenates them
      (Zed's `on_terminal_provider_event`) and the user reads the duplicate;
    - **a discontinuity budget declared per row**: the mapper may claim dropped
      bytes only when the producer's own tail buffer genuinely rolled between
      two snapshots. Anything above the declared count is a fabrication.
    Both fired on oh-my-pi/oh-my-pi#7078 review 4824091334: past the 50 KB
    rollover floor, `OutputSink`'s middle-elided final summary starts with the
    run's *original head* (zero overlap with the streamed tail) and is slightly
    *longer* than the watermark, so the floor shortcut classified a pure
    re-render as a rollover — a false `[terminal output discontinuity]` plus a
    second copy of the whole 51 KB summary. The floor is now additionally gated
    on `isDisplayReRendered` (the producer's own `details.meta` markers): a
    positive signal beside the structural length invariant, since a re-render
    that *grew* has no length signal and its zero overlap is legitimate.
    **Pick row data that makes the trigger deterministic**: with variable-width
    lines the streamed watermark landed a byte or two under the floor about a
    third of the time and the buggy code passed by luck, so the row uses
    fixed-width 64-byte lines (51,200 / 64 is exact) — and *unique* ones, since
    self-similar filler makes the append-only probe fire on legitimate
    deliveries. `acp-probe` enforces the same append-only property on every run
    against the real wire (`duplicateTerminalDeliveries`/
    `discontinuityNotices` in its summary, exit 1 on a repeat).
17. **A check placed only where its fixtures cannot populate the field it
    reads enforces nothing — and every declared fact axis needs its own
    non-vacuity proof, not just the mechanism's existence.** Rule 15's
    matrix check ("no fact the producer recorded structurally is missing
    from the frame") is the right mechanism, but it lived only in
    `acp-producer-wire.test.ts`, whose rows are real tool results: no row's
    real producer ever set `details.notice` (`ResolvedBackend.notice` has no
    writer anywhere in `src/`), so that declared axis was read on every row
    and never once failed. The mapper's eval image fallback (the
    `wantsMetaTerminal` branch that drops the terminal item for an image)
    composed `content` by hand instead of going through the shared notice/
    `directText` collection point every other terminal-rendering exit path
    used, dropped `details.notice`/`errorMessage`, and shipped anyway
    (oh-my-pi/oh-my-pi#7078 review 4829715458). `extractTerminalDeliverableFacts`
    (`acp-event-mapper.ts`) is now the one place `extractTerminalNotices` and
    `extractDirectText` are joined; `buildLiveTerminalNoticeMeta`,
    `buildFinalMetaTerminalDelta` (which was itself missing `directText` on
    the display-only meta path, a second unreported instance of the same
    class), and the image fallback all compose through it. The check itself
    now also runs in `acp-event-mapper.test.ts`'s `mapUpdates()` wrapper (via
    `test/helpers/acp-producer-facts.ts`, shared with the matrix), since that
    suite's hand-fabricated fixtures *can* declare any fact combination a
    real producer's type doesn't allow — confirmed necessary: `eval`'s image
    and `details.notice` cannot occur together through any typed production
    entrypoint (`EvalProxyExecutor`'s declared return type is text-only content,
    and `tsgo` rejects the combined shape outright), so only the mapper
    suite's synthetic fixtures can exercise that exact combination, while the
    matrix covers each axis separately with a real producer. A **vacuity
    guard** — asserting each declared fact axis is actually non-empty on at
    least one row's real result — is now part of the matrix itself, proven
    non-vacuous the same way every other guard in this doc is: blank the one
    row that populates an axis and confirm the guard fails before restoring
    it. When a fact axis has no real single-tool producer at all within a
    suite's scope (the top-level `errorMessage` this PR chased is
    synthesized by the agent loop's permission-cancellation catch, a layer
    above any `AgentTool.execute()` result — see `docs/acp-development.md`
    rule 15's matrix scope), that is itself a fact worth recording in the
    test, not silently working around by fabricating a producer that
    doesn't exist.

18. **Every check in this doc catches extra or contradictory bytes — until this
   rule, none caught missing ones.** `checkAcpUpdateInvariants` (rule 7/9),
   the append-only probe and discontinuity budget (rule 16), and the
   fact-axis check (rule 15/17) all fire on something the frame *shouldn't*
   contain: a sibling item, an unnegotiated `_meta` key, a repeated byte run,
   a fabricated data-loss claim, a declared-but-absent fact. None of them can
   fail on a frame that's simply missing a fact the producer never declared
   structurally in the first place — that's a `producerFacts` vacuity
   (rule 17) one layer removed: `eval` recorded a kernel-timeout/stdin-
   request annotation **only** by baking it into the model-facing `output`
   text (`OutputSink.dump(notice)` composes the returned body directly and
   never calls `onChunk` with it, unlike `push()`, which every other chunk
   goes through), so `details` had no `notices` field at all — nothing was
   "missing from what got declared" because nothing was declared
   (oh-my-pi/oh-my-pi#7078, a later round of the same review; the JS backend
   only avoided this by calling `push(annotation)` before `dump()`, streaming
   it live by accident, not by design). `missingFinalBodyLines`
   (`test/helpers/acp-producer-facts.ts`) closes the omission direction
   itself: every non-blank line of the producer's own authoritative final
   body text (`content[].text`, the same text a plain-content client would
   render verbatim) must appear somewhere across every rendered channel in
   the *whole* replayed sequence — needing no axis declared first, since it
   reads the same text a plain fallback client already shows regardless of
   which structural field (if any) carries a given fact. Wired into
   `acp-producer-wire.test.ts`'s matrix only, not `acp-event-mapper.test.ts`:
   the check is only meaningful against a *real* producer's authoritative
   text, and that suite's ~90 hand-fabricated fixtures have none — wiring it
   there would test whether a test author's typed string round-trips, not
   whether real behavior does, the exact anti-pattern rule 15 exists to
   avoid.

   Three false positives came before the check was trustworthy, each fixed
   by narrowing what the check demands rather than by weakening it into
   silence: (1) a bracket mismatch — the model-facing text wraps a
   `dump(notice)` annotation as `[${notice}]`, but the mirrored
   `details.notices` entry didn't, so an exact fix landed with the wrong
   literal and the check still failed until the mirror matched the
   convention bash's own notices already use; (2) a middle-elided summary
   (bash's/eval's own tail-buffer rollover, rule 16) legitimately contains
   thousands of line numbers that were dropped before the mapper ever saw
   them — check #4's declared discontinuity count already vouches for
   exactly that loss with the right granularity, so a row with a declared
   discontinuity skips this check rather than needing a per-line allowance
   in the thousands; (3) a real client-owned terminal's body streams over
   the actual `terminal/output` RPC a client polls independently of
   `session/update`, invisible to an in-process replay by construction, not
   by omission — rows with a `terminalId` (a real, connection-owned
   terminal) are exempt for that reason, proven still meaningful by the
   `stdin requested`/`kernel timeout mid-stream` rows below, which have no
   `terminalId` and did fail pre-fix. A genuine, documented exception earns
   `allowUndeliveredFinalLines`; a real loss never does — every exemption
   above was justified by what the producer/client is structurally
   incapable of, not chosen to make a red row green. Non-vacuity confirmed
   twice: the two new rows fail pre-fix with exactly the two annotations
   named in this rule, pass post-fix, and reverting the fix with the check's
   exemptions already in place still fails only those rows and nothing else.

   The same "a harness re-implements a checked-elsewhere verdict instead of
   trusting it, and the reimplementation goes stale" mistake showed up one
   level up the same day: `scripts/acp-stress-matrix.sh`'s `min=` assertion
   read only `stress-output`'s parsed `delivered=` byte count against a
   floor, ignoring the subcommand's own exit code — which was already the
   authoritative verdict for *both* the byte-shortfall axis (admitted
   producer cap vs. silent suppression) and the append-only axis (any
   duplicate terminal delivery fails unconditionally, `acp-probe.ts`'s
   post-switch check). A duplicate-resend regression *raises* `delivered`
   rather than shrinking it, so the stale floor-only check reported `PASS`
   on exactly the shape of bug the exit code was already built to catch —
   confirmed live by breaking the watermark update on purpose:
   `delivered=181565 >= 60000` read `OK` under the old logic while the
   probe's own exit code was `1` (3 duplicate-delivery violations). Fixed by
   requiring `code == 0` in addition to the floor, restoring the exit code
   as the single source of truth the floor is now just a display-only sanity
   check on top of.

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
`omp acp` process instead of by hand — see acp-probe's README for both. Every probe run
additionally models each display-only terminal buffer as a client would and fails (exit 1)
if a delivery repeats bytes already sent for that terminal id, reporting
`duplicateTerminalDeliveries` and `discontinuityNotices` in its summary — the wire-level
half of rule 16, and the check that caught a re-sent 51 KB body live before the unit
matrix did.

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
