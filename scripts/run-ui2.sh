#!/usr/bin/env bash
# Runs UI rebuild phases U1..U5 one after another with Claude Code, unattended.
# Usage (from the repo root):  caffeinate -is ./scripts/run-ui.sh        (or: ./scripts/run-ui.sh U3  to start from U3)
set -u
cd "$(dirname "$0")/.."
mkdir -p logs
START="${1:-U1}"
MODEL="${MODEL:-sonnet}"
PHASES=(U1 U2 U3 U4 U6 U7 U5)
started=0
for P in "${PHASES[@]}"; do
  [ "$P" = "$START" ] && started=1
  [ $started -eq 0 ] && continue
  if grep -q "PHASE $P: DONE" docs/ui-progress.md 2>/dev/null; then echo "$P already done, skipping"; continue; fi
  attempt=0
  while ! grep -q "PHASE $P: DONE" docs/ui-progress.md 2>/dev/null; do
    attempt=$((attempt+1))
    echo "=== $(date '+%H:%M') $P attempt $attempt ===" | tee -a "logs/$P.log"
    PROMPT="$(cat docs/ui-phases/common.md)"$'\n\n'"$(cat docs/ui-phases/$P.md)"$'\n\n'"The phase name for screenshots and progress is $P."
    claude -p "$PROMPT" --model "$MODEL" --permission-mode acceptEdits >> "logs/$P.log" 2>&1
    git pull --ff-only >/dev/null 2>&1 || true
    if grep -q "PHASE $P: DONE" docs/ui-progress.md 2>/dev/null; then break; fi
    if [ $attempt -ge 8 ]; then echo "$P did not finish after 8 attempts; stopping. See logs/$P.log" | tee -a "logs/$P.log"; exit 1; fi
    echo "$P not done yet (usage limit or stopped). Waiting 20 min, then continuing." | tee -a "logs/$P.log"
    sleep 1200
  done
  echo "=== $(date '+%H:%M') $P DONE ===" | tee -a "logs/$P.log"
done
echo "All phases done. Run: npm run demo  and open http://localhost:3000"
