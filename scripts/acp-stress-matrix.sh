#!/usr/bin/env bash
# Stress-tests the current omp branch's ACP mapper across the
# tool x capability-channel x byte-size matrix that oh-my-pi/oh-my-pi#7078's
# 6-round review exists to prevent regressing again. See
# docs/acp-development.md rules 7-9.
#
# Runs acp-probe's `stress-output` (byte-exactness on the meta-terminal path,
# expected truncation on the fenced-text fallback) and `kill-mid-tool`
# (dangling-replay status) against a real `omp acp` subprocess — this is the
# dev launcher (`scripts/omp`), not the installed binary, so it always
# exercises this checkout's actual source per docs/acp-development.md's
# "Don't run build-binary.ts" rule.
#
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
omp_root="$(cd "$script_dir/.." && pwd)"
probe_dir="${1:-$omp_root/../acp-probe}"
omp_cmd="${2:-$omp_root/packages/coding-agent/scripts/omp}"

if [ ! -f "$probe_dir/src/acp-probe.ts" ]; then
	echo "acp-stress-matrix: no acp-probe checkout at $probe_dir (pass its path as \$1)" >&2
	exit 2
fi
if [ ! -x "$omp_cmd" ]; then
	echo "acp-stress-matrix: no omp launcher at $omp_cmd (pass its path as \$2)" >&2
	exit 2
fi

export ACP_PROBE_CMD="$omp_cmd"
log_dir="$(mktemp -d)"
pass=0
fail=0
rows=()

run_probe() {
	# run_probe <label> <expect-exit> <probe-args...>
	local label="$1" want="$2"
	shift 2
	local log="$log_dir/$label.log" out="$log_dir/$label.out"
	(cd "$probe_dir" && bun run src/acp-probe.ts "$@" --timeout-ms 90000 --log "$log") >"$out" 2>&1
	local code=$?
	local delivered
	delivered=$(grep -o 'delivered=[0-9]*' "$out" | tail -1 | cut -d= -f2)
	local status="OK"
	if [ "$code" != "$want" ]; then
		status="REGRESSION"
		fail=$((fail + 1))
	else
		pass=$((pass + 1))
	fi
	rows+=("$(printf '%-28s exit=%s want=%s delivered=%-8s %s' "$label" "$code" "$want" "${delivered:-  -}" "$status")")
}

echo "stress-output: tool x channel x size"
for tool in bash eval; do
	for channel in meta fenced; do
		if [ "$channel" = meta ]; then
			caps=(--meta '{"terminal_output":true}')
		else
			caps=()
		fi
		for size in 3000 4096 10000 60000 120000; do
			# Meta-terminal path must never truncate, at any size (the exact
			# regression rules 7-9 exist for). The fenced-text fallback is
			# *supposed* to truncate above ACP_TEXT_LIMIT (documented as 4000
			# chars) -- exit 1 there is the correct, unregressed behavior.
			if [ "$channel" = meta ] || [ "$size" -le 4000 ]; then
				want=0
			else
				want=1
			fi
			run_probe "$tool-$channel-$size" "$want" stress-output "$size" "$tool" "${caps[@]}"
		done
	done
done

echo
echo "kill-mid-tool: dangling replay status across capability combos"
for combo in none terminal meta both; do
	case "$combo" in
	none) caps=() ;;
	terminal) caps=(--terminal) ;;
	meta) caps=(--meta '{"terminal_output":true}') ;;
	both) caps=(--terminal --meta '{"terminal_output":true}') ;;
	esac
	run_probe "kill-mid-tool-$combo" 0 kill-mid-tool "Use the bash tool to run: sleep 20" "${caps[@]}"
done

echo
printf '%s\n' "${rows[@]}"
echo
echo "logs: $log_dir"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
