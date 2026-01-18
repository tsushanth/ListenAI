#!/bin/bash
# Load test script for TTS service
# Tests both Kokoro (fast) and XTTS (high quality) models
# with varying text lengths and concurrent requests

TTS_URL="${TTS_URL:-https://readaloud-tts-3t2vweivqa-uc.a.run.app}"

# Text samples of varying lengths
SHORT_TEXT="Hello, this is a test."
MEDIUM_TEXT="The quick brown fox jumps over the lazy dog. This is a test of the text to speech system. We want to understand how performance scales with longer text passages."
LONG_TEXT="In the realm of artificial intelligence, text to speech technology has made remarkable strides over the past decade. Modern neural network based systems can now produce speech that is nearly indistinguishable from human voices. This advancement has opened up new possibilities for accessibility, content creation, and user interfaces. The ability to convert written text into natural sounding audio has transformed how we interact with technology. From virtual assistants to audiobook narration, these systems are becoming increasingly integrated into our daily lives."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   TTS Service Load Test${NC}"
echo -e "${BLUE}   URL: $TTS_URL${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""

# Function to run a single test
run_test() {
    local model=$1
    local text=$2
    local label=$3

    local result=$(curl -s -X POST "$TTS_URL/synthesize" \
        -H "Content-Type: application/json" \
        -d "{\"text\": \"$text\", \"model\": \"$model\", \"voice_id\": \"default\"}" \
        -o /dev/null \
        -w "%{http_code} %{time_total} %{size_download}")

    local http_code=$(echo $result | awk '{print $1}')
    local time_total=$(echo $result | awk '{print $2}')
    local size=$(echo $result | awk '{print $3}')

    if [ "$http_code" == "200" ]; then
        echo -e "${GREEN}✓${NC} $label: ${time_total}s (${size} bytes)"
    else
        echo -e "${RED}✗${NC} $label: HTTP $http_code"
    fi

    echo "$time_total"
}

# Function to run concurrent tests
run_concurrent_test() {
    local model=$1
    local text=$2
    local concurrency=$3

    echo -e "${YELLOW}Running $concurrency concurrent requests (${model})...${NC}"

    local start_time=$(date +%s.%N)
    local pids=()
    local results_file="/tmp/tts_concurrent_results_$$"

    for i in $(seq 1 $concurrency); do
        (
            local result=$(curl -s -X POST "$TTS_URL/synthesize" \
                -H "Content-Type: application/json" \
                -d "{\"text\": \"$text request $i\", \"model\": \"$model\", \"voice_id\": \"default\"}" \
                -o /dev/null \
                -w "%{http_code} %{time_total}")
            echo "$result" >> "$results_file"
        ) &
        pids+=($!)
    done

    # Wait for all to complete
    for pid in "${pids[@]}"; do
        wait $pid
    done

    local end_time=$(date +%s.%N)
    local total_time=$(echo "$end_time - $start_time" | bc)

    # Analyze results
    local success=0
    local failed=0
    local total_response_time=0

    while read line; do
        local code=$(echo $line | awk '{print $1}')
        local time=$(echo $line | awk '{print $2}')
        if [ "$code" == "200" ]; then
            ((success++))
            total_response_time=$(echo "$total_response_time + $time" | bc)
        else
            ((failed++))
        fi
    done < "$results_file"

    local avg_time=$(echo "scale=2; $total_response_time / $success" | bc 2>/dev/null || echo "N/A")

    echo -e "  Results: ${GREEN}$success success${NC}, ${RED}$failed failed${NC}"
    echo -e "  Wall clock: ${total_time}s"
    echo -e "  Avg response: ${avg_time}s"
    echo ""

    rm -f "$results_file"
}

# ============================================
# Test 1: Health Check
# ============================================
echo -e "${BLUE}--- Test 1: Health Check ---${NC}"
health_result=$(curl -s "$TTS_URL/health")
echo "$health_result" | python3 -m json.tool 2>/dev/null || echo "$health_result"
echo ""

# ============================================
# Test 2: Single Request Performance (Kokoro)
# ============================================
echo -e "${BLUE}--- Test 2: Kokoro Single Requests ---${NC}"
echo "Short text (~5 words):"
run_test "kokoro" "$SHORT_TEXT" "  Kokoro short"

echo "Medium text (~30 words):"
run_test "kokoro" "$MEDIUM_TEXT" "  Kokoro medium"

echo "Long text (~100 words):"
run_test "kokoro" "$LONG_TEXT" "  Kokoro long"
echo ""

# ============================================
# Test 3: Single Request Performance (XTTS)
# ============================================
echo -e "${BLUE}--- Test 3: XTTS Single Requests ---${NC}"
echo "Short text (~5 words):"
run_test "xtts" "$SHORT_TEXT" "  XTTS short"

echo "Medium text (~30 words):"
run_test "xtts" "$MEDIUM_TEXT" "  XTTS medium"
echo ""

# ============================================
# Test 4: Concurrent Requests (Kokoro)
# ============================================
echo -e "${BLUE}--- Test 4: Kokoro Concurrent Requests ---${NC}"
run_concurrent_test "kokoro" "$SHORT_TEXT" 3
run_concurrent_test "kokoro" "$SHORT_TEXT" 5

# ============================================
# Test 5: Concurrent Requests (XTTS)
# ============================================
echo -e "${BLUE}--- Test 5: XTTS Concurrent Requests ---${NC}"
run_concurrent_test "xtts" "$SHORT_TEXT" 2

# ============================================
# Test 6: Mixed Model Concurrent
# ============================================
echo -e "${BLUE}--- Test 6: Mixed Model Concurrent ---${NC}"
echo -e "${YELLOW}Running 2 Kokoro + 1 XTTS concurrently...${NC}"

start_time=$(date +%s.%N)

(curl -s -X POST "$TTS_URL/synthesize" \
    -H "Content-Type: application/json" \
    -d '{"text": "Kokoro request one", "model": "kokoro"}' \
    -o /dev/null \
    -w "Kokoro 1: %{time_total}s HTTP %{http_code}\n") &

(curl -s -X POST "$TTS_URL/synthesize" \
    -H "Content-Type: application/json" \
    -d '{"text": "Kokoro request two", "model": "kokoro"}' \
    -o /dev/null \
    -w "Kokoro 2: %{time_total}s HTTP %{http_code}\n") &

(curl -s -X POST "$TTS_URL/synthesize" \
    -H "Content-Type: application/json" \
    -d '{"text": "XTTS request one", "model": "xtts"}' \
    -o /dev/null \
    -w "XTTS 1: %{time_total}s HTTP %{http_code}\n") &

wait

end_time=$(date +%s.%N)
total_time=$(echo "$end_time - $start_time" | bc)
echo -e "Total wall clock: ${total_time}s"
echo ""

# ============================================
# Summary
# ============================================
echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   Load Test Complete${NC}"
echo -e "${BLUE}============================================${NC}"
echo ""
echo "Expected performance:"
echo "  Kokoro: <1s for short, <5s for medium, <15s for long"
echo "  XTTS:   15-20s for short, 60-120s for medium"
echo ""
echo "For production, consider:"
echo "  - Use Kokoro as default (fast, Apache licensed)"
echo "  - Reserve XTTS for voice cloning only"
echo "  - Set min-instances=1 to avoid cold starts"
