#!/usr/bin/env bash
# Generate realistic NewAPI consume logs for the past 7 days, attributed to
# the ConnectMulti ingest user (user_id=2, username=connectmulti), and recompute
# the matching quota_data hourly buckets. Safe to re-run: it deletes any rows
# tagged with content='ConnectMulti seed' before re-seeding.
#
# Usage:  ./scripts/seed-newapi-logs.sh [days_back]
# Requires: docker, the new-api-local container with sqlite3 installed inside.

set -euo pipefail

DAYS_BACK="${1:-7}"
CONTAINER="${NEWAPI_CONTAINER:-new-api-local}"
DB_PATH="${NEWAPI_DB_PATH:-/data/one-api.db}"

# macOS BSD date: today 00:00 in epoch seconds.
TODAY=$(date -v0H -v0M -v0S +%s)
NOW=$(date +%s)
DAY=86400
HOUR=3600

MODELS=(
  "gpt-4o"
  "claude-3.5-sonnet"
  "gemini-1.5-pro"
  "deepseek-v3"
  "doubao-1-5-pro-32k-250115"
)

# Per-model weights so the distribution feels uneven (matches what you'd see
# with one heavy model and a few quieter ones).
WEIGHTS=(40 28 18 9 5)
WEIGHT_TOTAL=100

pick_model() {
  local roll=$((RANDOM % WEIGHT_TOTAL))
  local acc=0
  local i
  for i in "${!MODELS[@]}"; do
    acc=$((acc + WEIGHTS[i]))
    if [ "$roll" -lt "$acc" ]; then
      echo "${MODELS[i]}"
      return
    fi
  done
  echo "${MODELS[0]}"
}

SQL_FILE=$(mktemp -t newapi-seed)
trap 'rm -f "$SQL_FILE"' EXIT

START_DAY=$((TODAY - (DAYS_BACK - 1) * DAY))

{
  echo "BEGIN;"
  echo "DELETE FROM logs WHERE user_id=2 AND content='ConnectMulti seed';"
  echo "DELETE FROM quota_data WHERE user_id=2 AND username='connectmulti' AND created_at >= $START_DAY;"

  total_rows=0
  for d in $(seq 0 $((DAYS_BACK - 1))); do
    day_start=$((START_DAY + d * DAY))
    # Per-day traffic ramp: lower in the early morning, peak around 10-16, taper.
    # Today is filled in full (all 24 hours) even when the script runs early in
    # the day — this is demo data, the goal is a complete trend silhouette.
    for h in $(seq 0 23); do
      hour_start=$((day_start + h * HOUR))
      # event count shape: 1..6 with peak mid-day
      case $h in
        0|1|2|3|4|5) base=1 ;;
        6|7|8) base=2 ;;
        9|10|11|12|13|14|15|16) base=4 ;;
        17|18|19) base=3 ;;
        20|21|22|23) base=2 ;;
        *) base=2 ;;
      esac
      count=$((base + RANDOM % 3))
      # Quiet-hours multiplier: keep 00-05 token sizes well below daytime so a
      # single midnight event doesn't read as a mountain on the trend chart.
      case $h in
        0|1|2|3|4|5)   size_div=4 ;;
        6|7|8|22|23)   size_div=2 ;;
        *)             size_div=1 ;;
      esac
      for i in $(seq 1 "$count"); do
        ts=$((hour_start + RANDOM % HOUR))
        model=$(pick_model)
        # Token sizes vary per model so the chart shows mass differences.
        case "$model" in
          gpt-4o)        prompt=$((400 + RANDOM % 2600));  completion=$((150 + RANDOM % 900)) ;;
          claude-3.5-sonnet) prompt=$((600 + RANDOM % 3000)); completion=$((200 + RANDOM % 1300)) ;;
          gemini-1.5-pro)    prompt=$((1000 + RANDOM % 5000)); completion=$((150 + RANDOM % 800)) ;;
          deepseek-v3)       prompt=$((300 + RANDOM % 2000));  completion=$((100 + RANDOM % 700)) ;;
          *)                 prompt=$((250 + RANDOM % 1500));  completion=$((80 + RANDOM % 500)) ;;
        esac
        prompt=$((prompt / size_div + 50))
        completion=$((completion / size_div + 20))
        cached=0
        # ~30% chance of partial cache hit
        if [ $((RANDOM % 10)) -lt 3 ]; then
          cached=$((100 + RANDOM % (prompt / 2)))
        fi
        reasoning=0
        case "$model" in
          gemini-1.5-pro|deepseek-v3)
            if [ $((RANDOM % 3)) -eq 0 ]; then
              reasoning=$((200 + RANDOM % 1500))
            fi
            ;;
        esac
        total=$((prompt + completion))
        quota=$((total / 10 + 1))
        rid="seed-${d}-${h}-${i}"
        # Provider is the .cc proxy fan-out destination, inferred from the
        # model so the by-provider panel has real variety.
        case "$model" in
          gpt-*)     provider="openai" ;;
          claude-*)  provider="claude-code-micu" ;;
          gemini-*)  provider="gemini" ;;
          deepseek-*) provider="deepseek" ;;
          doubao-*)  provider="doubao" ;;
          *)         provider="mock" ;;
        esac
        other='{"usage_ingest":true,"provider":"'"$provider"'","source_app":"seed-script","cached_input_tokens":'"$cached"',"reasoning_tokens":'"$reasoning"',"cache_miss_tokens":0}'
        printf 'INSERT INTO logs (user_id, created_at, type, content, username, token_name, model_name, quota, prompt_tokens, completion_tokens, use_time, is_stream, channel_id, token_id, "group", request_id, other) VALUES (2, %d, 2, '"'"'ConnectMulti seed'"'"', '"'"'connectmulti'"'"', '"'"'seed'"'"', '"'"'%s'"'"', %d, %d, %d, %d, 0, 0, 0, '"'"'default'"'"', '"'"'%s'"'"', '"'"'%s'"'"');\n' \
          "$ts" "$model" "$quota" "$prompt" "$completion" "$((1 + RANDOM % 8))" "$rid" "$other"
        total_rows=$((total_rows + 1))
      done
    done
  done

  # Rebuild quota_data from the seed rows so /api/data and lifetime totals match.
  echo "INSERT INTO quota_data (user_id, username, model_name, created_at, token_used, count, quota)"
  echo "  SELECT user_id, username, model_name, (created_at - created_at % 3600),"
  echo "         SUM(prompt_tokens + completion_tokens), COUNT(*), SUM(quota)"
  echo "  FROM logs"
  echo "  WHERE user_id=2 AND content='ConnectMulti seed'"
  echo "  GROUP BY user_id, username, model_name, (created_at - created_at % 3600);"

  echo "COMMIT;"
  echo ".changes on"
  echo "SELECT 'seeded rows', COUNT(*) FROM logs WHERE user_id=2 AND content='ConnectMulti seed';"
  echo "SELECT 'quota_data rows', COUNT(*) FROM quota_data WHERE user_id=2 AND username='connectmulti' AND created_at >= $START_DAY;"
} > "$SQL_FILE"

echo "Applying seed (~$(wc -l < "$SQL_FILE") SQL statements) to $CONTAINER:$DB_PATH ..."
docker exec -i "$CONTAINER" sqlite3 "$DB_PATH" < "$SQL_FILE"
echo "Done."
