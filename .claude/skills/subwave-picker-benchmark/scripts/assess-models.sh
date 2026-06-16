#!/usr/bin/env bash
# Benchmark candidate LLM models for the SUB/WAVE DJ picker agent.
#
# Runs controller/scripts/picker-test.mjs across one or more models, in both
# `short` and `long` message modes, then prints a comparison table and a summary
# of the failure reasons found in the event log.
#
# WHERE IT RUNS — dev vs prod matters, and the script auto-detects it:
#   - DEV stack: the controller container bind-mounts `controller/src` and runs
#     tsx, so the harness runs INSIDE the container (no host deps needed).
#   - PROD stack: the image ships compiled `dist/` with NO `src/`, so an
#     in-container run dies with `ERR_MODULE_NOT_FOUND: /app/src/settings.js`.
#     There the harness runs on the HOST (it imports the repo's TS source via
#     tsx) with STATE_DIR pointed at the repo's state dir, the provider API keys
#     copied out of the container env, and OLLAMA_URL translated to a
#     host-reachable address.
#
# Read-only: picker-test.mjs overrides provider/model only inside its own
# short-lived process, so the live station's configured model is never changed.
set -uo pipefail

CONTAINER=sub-wave-controller
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/../../../..")
STATE_DIR="$REPO/state"

# Provider API keys the harness might need. The host run copies whichever of
# these are set in the container env so a host-side run authenticates exactly
# like the live controller does.
KEY_NAMES=(DEEPSEEK_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY \
           GOOGLE_GENERATIVE_AI_API_KEY GEMINI_API_KEY AI_GATEWAY_API_KEY)

usage() {
  cat <<'EOF'
Usage: assess-models.sh <provider> [iterations] <model> [<model> ...]

  provider     ollama | openai-compatible | anthropic | openai | google |
               deepseek | openrouter | gateway
  iterations   runs per model per mode (default 10; use 20+ to confirm a winner)
  model ...    one or more model ids. If omitted and provider is ollama, every
               model installed on the Ollama box is discovered and tested.

IMPORTANT — test through the ROUTING you'll actually deploy. The same model can
pass through one provider and fail through another (observed: deepseek-v4-flash
0/4 via the `deepseek` direct provider, 4/4 via `openrouter` deepseek/deepseek-v4-flash).
If you intend to run a model via OpenRouter, benchmark it as `openrouter <id>`,
not as the native provider.

Examples:
  assess-models.sh openrouter 10 deepseek/deepseek-v4-flash google/gemini-3.5-flash
  assess-models.sh ollama 20 glm-5.1:cloud
  assess-models.sh ollama                 # auto-discover + test all ollama models
EOF
}

[ $# -lt 1 ] && { usage; exit 2; }

PROVIDER=$1; shift
ITERS=10
if [ $# -gt 0 ] && [[ $1 =~ ^[0-9]+$ ]]; then ITERS=$1; shift; fi
MODELS=("$@")

# Container must be up — even the host run reads keys + the configured Ollama URL
# from the live container so the benchmark matches the deployed config.
if ! docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -q .; then
  echo "error: container '${CONTAINER}' is not running — start the stack first (subwave-control)." >&2
  exit 1
fi

# Detect dev (src present in container) vs prod (compiled dist only).
if docker exec "$CONTAINER" test -f src/settings.js 2>/dev/null; then
  MODE_LOC=container
else
  MODE_LOC=host
fi
echo "Execution mode: ${MODE_LOC} ($([ "$MODE_LOC" = container ] && echo 'dev: src bind-mounted, run in container' || echo 'prod: dist only, run on host'))"

# ----- host-run prep -----------------------------------------------------------
HOST_ENV=()
if [ "$MODE_LOC" = host ]; then
  if [ ! -d "$REPO/controller/node_modules" ]; then
    echo "error: host run needs controller deps. Run: (cd '$REPO/controller' && npm ci)" >&2
    exit 1
  fi
  # Copy provider keys out of the live container so host auth == deployed auth.
  for k in "${KEY_NAMES[@]}"; do
    v=$(docker exec "$CONTAINER" printenv "$k" 2>/dev/null | tr -d '\r\n')
    [ -n "$v" ] && HOST_ENV+=("$k=$v")
  done
  # The configured Ollama URL likely uses host.docker.internal (resolvable only
  # inside the container); translate it to a host-reachable address. A real
  # host/IP (e.g. a Tailscale address) is left as-is — it resolves from the host.
  OLLAMA_CFG=$(node -e "try{console.log(require('$STATE_DIR/settings.json').llm.ollamaUrl||'')}catch(e){console.log('')}" 2>/dev/null)
  if printf '%s' "$OLLAMA_CFG" | grep -q 'host.docker.internal'; then
    HOST_ENV+=("OLLAMA_URL=http://localhost:11434")
  elif [ -n "$OLLAMA_CFG" ]; then
    HOST_ENV+=("OLLAMA_URL=$OLLAMA_CFG")
  fi
  HOST_ENV+=("STATE_DIR=$STATE_DIR")
fi

# run_harness <provider> <model> <iters> <mode> -> harness stdout+stderr
run_harness() {
  if [ "$MODE_LOC" = container ]; then
    docker exec "$CONTAINER" npx tsx scripts/picker-test.mjs "$1" "$2" "$3" "$4" 2>&1
  else
    ( cd "$REPO/controller" && env "${HOST_ENV[@]}" npx tsx scripts/picker-test.mjs "$1" "$2" "$3" "$4" 2>&1 )
  fi
}

# Auto-discover ollama models when none were named.
if [ ${#MODELS[@]} -eq 0 ]; then
  if [ "$PROVIDER" != "ollama" ]; then
    echo "error: no models given — auto-discovery is only supported for provider 'ollama'." >&2
    exit 2
  fi
  echo "Discovering models on the Ollama box..."
  mapfile -t MODELS < <(
    docker exec "$CONTAINER" sh -c 'curl -s http://host.docker.internal:11434/api/tags' \
      | python3 -c 'import json,sys; [print(m["name"]) for m in json.load(sys.stdin).get("models",[])]' 2>/dev/null
  )
  [ ${#MODELS[@]} -eq 0 ] && { echo "error: discovered no models — is the Ollama box reachable?" >&2; exit 1; }
  echo "Found: ${MODELS[*]}"
fi

echo
echo "=== picker benchmark: provider=${PROVIDER}  iterations=${ITERS}  models=${#MODELS[@]} ==="
echo

ROWS=$(mktemp)
echo -e "MODEL\tMODE\tSUCCESS\tms_median\tms_p95\ttoolcalls" > "$ROWS"

parse_summary() {
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys
model, mode, out = sys.argv[1], sys.argv[2], sys.argv[3]
def find(pat, default="-"):
    m = re.search(pat, out)
    return m.group(1) if m else default
success = find(r"success:\s*([0-9]+/[0-9]+ \([0-9]+%\))")
ms_med  = find(r"ms \(ok\):\s*median=(\S+)")
ms_p95  = find(r"ms \(ok\):.*p95=(\S+)")
tools   = find(r"median tool calls per ok:\s*(\S+)")
print(f"{model}\t{mode}\t{success}\t{ms_med}\t{ms_p95}\t{tools}")
PY
}

for MODEL in "${MODELS[@]}"; do
  for MODE in short long; do
    echo "--- ${MODEL} (${MODE}) ---"
    OUT=$(run_harness "$PROVIDER" "$MODEL" "$ITERS" "$MODE")
    echo "$OUT" | grep -E '^\s*(OK|FAIL|success:|modes:|ms \(|median tool)' || { echo "  (no summary — run errored)"; echo "$OUT" | tail -3 | sed 's/^/    /'; }
    parse_summary "$MODEL" "$MODE" "$OUT" >> "$ROWS"
    echo
  done
done

echo "================ comparison ================"
# Align into columns without depending on `column` (not installed everywhere).
python3 - "$ROWS" <<'PY'
import sys
rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1]) if l.strip()]
if rows:
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(c.ljust(widths[i]) for i, c in enumerate(r)))
PY
rm -f "$ROWS"
echo

# Failure reasons: read the real error strings from the event log. state/ is the
# host side of the container's /var/sub-wave mount, so read it on the host either
# way — works whether the harness ran in the container or on the host.
echo "============ failure reasons (recent pickerTest calls) ============"
cat "$STATE_DIR"/logs/events-*.jsonl 2>/dev/null \
  | python3 - "${MODELS[@]}" <<'PY'
import json, sys
wanted = set(sys.argv[1:])
counts = {}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    if e.get("type") != "llm" or e.get("kind") != "pickerTest" or e.get("ok"):
        continue
    if wanted and not any(w in (e.get("model") or "") for w in wanted):
        continue
    key = (e.get("model"), e.get("error") or "(no error string)")
    counts[key] = counts.get(key, 0) + 1
if not counts:
    print("  (no pickerTest failures in the event log)")
else:
    for (model, err), n in sorted(counts.items(), key=lambda x: -x[1]):
        print(f"  {n:>3}x  {model}  |  {err}")
PY
echo
echo "Done. Judge on success rate first, then latency. See SKILL.md for the"
echo "failure-mode glossary and how to phrase the recommendation."
