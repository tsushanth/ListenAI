#!/usr/bin/env python3
"""
Benchmark: Cloud Run GPU (L4) vs Modal GPU (T4)
Measures latency, audio quality, and calculates real cost per request.
"""

import time
import json
import hashlib
import statistics
import sys
import os

import httpx

# Service URLs
CLOUD_RUN_GPU = "https://readaloud-tts-gpu-917362189743.us-central1.run.app"
MODAL_T4 = "https://t-sushanth--readaloud-tts-web.modal.run"

# Pricing (per second)
PRICING = {
    "cloud_run_gpu": {
        "name": "Cloud Run L4 GPU",
        "gpu_per_sec": 0.000183,   # L4 GPU
        "cpu_per_sec": 0.0000576,  # 4 vCPU (no throttling)
        "mem_per_sec": 0.0000064,  # 16Gi
        "note": "Billed for ENTIRE instance lifetime (cpu-throttling=false)",
    },
    "modal_t4": {
        "name": "Modal T4 GPU",
        "gpu_per_sec": 0.000164,   # T4
        "note": "Billed per-second of actual compute ONLY",
    },
}

# Test cases
TEST_CASES = [
    {
        "name": "Short (1 sentence)",
        "text": "Hello, this is a test of the text to speech synthesis system.",
        "voice_id": "af_heart",
    },
    {
        "name": "Medium (3 sentences)",
        "text": "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump.",
        "voice_id": "am_adam",
    },
    {
        "name": "Paragraph (~500 chars)",
        "text": (
            "Artificial intelligence has made remarkable strides in recent years, "
            "transforming industries from healthcare to finance. Machine learning models "
            "can now process vast amounts of data to identify patterns that would be "
            "impossible for humans to detect. Natural language processing has enabled "
            "computers to understand and generate human language with unprecedented "
            "accuracy. Computer vision systems can now recognize objects and faces with "
            "superhuman precision. These advances are driving innovation across the globe."
        ),
        "voice_id": "af_bella",
    },
    {
        "name": "Long (~1500 chars)",
        "text": (
            "The history of computing is a fascinating journey that spans centuries. "
            "From the abacus used by ancient civilizations to Charles Babbage's Analytical "
            "Engine in the 1830s, humans have long sought mechanical aids for calculation. "
            "The modern era of computing began in the 1940s with machines like ENIAC, "
            "which filled entire rooms and consumed enormous amounts of electricity. "
            "The invention of the transistor in 1947 revolutionized electronics, paving "
            "the way for smaller, faster, and more reliable computers. The development "
            "of integrated circuits in the 1960s further accelerated progress, leading "
            "to the microprocessor revolution of the 1970s. Personal computers became "
            "widespread in the 1980s, bringing computing power to homes and offices. "
            "The internet connected these machines in the 1990s, creating a global "
            "network that transformed communication, commerce, and culture. Today, "
            "we carry in our pockets smartphones that are millions of times more powerful "
            "than the computers that guided Apollo missions to the moon. The next frontier "
            "includes quantum computing, artificial intelligence, and brain-computer "
            "interfaces that promise to reshape our relationship with technology once again."
        ),
        "voice_id": "bm_george",
    },
]

NUM_RUNS = 3


def call_synthesize(base_url: str, text: str, voice_id: str, timeout: float = 180.0) -> dict:
    cache_buster = hashlib.md5(f"{time.time()}".encode()).hexdigest()[:8]
    payload = {
        "text": f"{text} [{cache_buster}]",
        "voice_id": voice_id,
        "model": "kokoro",
        "speed": 1.0,
    }

    start = time.time()
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{base_url}/synthesize", json=payload)
        elapsed = time.time() - start

        if resp.status_code != 200:
            return {"success": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}", "elapsed_ms": int(elapsed * 1000)}

        synthesis_time = resp.headers.get("X-Synthesis-Time-Ms", "N/A")
        return {
            "success": True,
            "elapsed_ms": int(elapsed * 1000),
            "synthesis_time_ms": int(synthesis_time) if synthesis_time != "N/A" else None,
            "audio_size_bytes": len(resp.content),
        }
    except Exception as e:
        return {"success": False, "error": str(e), "elapsed_ms": int((time.time() - start) * 1000)}


def warm_up(url, name):
    print(f"  Warming up {name}...")
    r = call_synthesize(url, "Warmup.", "af_heart", timeout=180)
    if r["success"]:
        print(f"  {name} ready ({r['elapsed_ms']}ms)")
    else:
        print(f"  {name} FAILED: {r.get('error', '')[:80]}")
    return r["success"]


def run_benchmark():
    services = {
        "cloud_run_gpu": {"url": CLOUD_RUN_GPU, "name": "Cloud Run L4"},
        "modal_t4": {"url": MODAL_T4, "name": "Modal T4"},
    }

    print("=" * 75)
    print("  TTS Benchmark: Cloud Run GPU (L4) vs Modal GPU (T4)")
    print("=" * 75)
    for k, v in services.items():
        print(f"  {v['name']}: {v['url']}")
    print(f"  Runs per test: {NUM_RUNS}\n")

    # Warmup
    print("Warming up services...")
    ready = {}
    for key, svc in services.items():
        ready[key] = warm_up(svc["url"], svc["name"])

    results = []

    for tc in TEST_CASES:
        print(f"\n--- {tc['name']} ({len(tc['text'])} chars) ---")
        result = {"test_case": tc["name"], "text_length": len(tc["text"]), "voice": tc["voice_id"]}

        for svc_key, svc in services.items():
            if not ready.get(svc_key):
                continue

            times = []
            synth_times = []
            sizes = []

            for run in range(NUM_RUNS):
                r = call_synthesize(svc["url"], tc["text"], tc["voice_id"])
                if r["success"]:
                    times.append(r["elapsed_ms"])
                    sizes.append(r["audio_size_bytes"])
                    if r["synthesis_time_ms"]:
                        synth_times.append(r["synthesis_time_ms"])
                    print(f"  {svc['name']} run {run+1}: {r['elapsed_ms']}ms (synth: {r.get('synthesis_time_ms', 'N/A')}ms), {r['audio_size_bytes']} bytes")
                else:
                    print(f"  {svc['name']} run {run+1}: FAILED - {r.get('error', '')[:60]}")

            if times:
                result[f"{svc_key}_e2e_avg_ms"] = int(statistics.mean(times))
                result[f"{svc_key}_e2e_min_ms"] = min(times)
                result[f"{svc_key}_e2e_max_ms"] = max(times)
                result[f"{svc_key}_audio_bytes"] = int(statistics.mean(sizes))
            if synth_times:
                result[f"{svc_key}_synth_avg_ms"] = int(statistics.mean(synth_times))

        results.append(result)

    # Summary table
    print("\n" + "=" * 95)
    print("  LATENCY COMPARISON (end-to-end including network)")
    print("=" * 95)
    print(f"{'Test Case':<25} {'Chars':>6} {'CR GPU e2e':>12} {'Modal e2e':>12} {'CR synth':>12} {'Modal synth':>12}")
    print("-" * 79)

    for r in results:
        cr_e2e = f"{r.get('cloud_run_gpu_e2e_avg_ms', 'N/A')}ms"
        m_e2e = f"{r.get('modal_t4_e2e_avg_ms', 'N/A')}ms"
        cr_synth = f"{r.get('cloud_run_gpu_synth_avg_ms', 'N/A')}ms"
        m_synth = f"{r.get('modal_t4_synth_avg_ms', 'N/A')}ms"
        print(f"{r['test_case']:<25} {r['text_length']:>6} {cr_e2e:>12} {m_e2e:>12} {cr_synth:>12} {m_synth:>12}")

    # Cost analysis
    print("\n" + "=" * 95)
    print("  COST PER REQUEST ANALYSIS")
    print("=" * 95)

    cr_pricing = PRICING["cloud_run_gpu"]
    m_pricing = PRICING["modal_t4"]

    print(f"\n  {'Test Case':<25} {'CR GPU Cost':>14} {'Modal Cost':>14} {'Modal Savings':>14}")
    print("  " + "-" * 67)

    for r in results:
        # Cloud Run: billed for entire e2e time (instance stays alive)
        cr_e2e_sec = r.get("cloud_run_gpu_e2e_avg_ms", 0) / 1000
        # Cloud Run actually bills for the full instance time, which includes idle
        # With no CPU throttling, the instance stays alive. Assume 30s min per wake-up.
        cr_billed_sec = max(cr_e2e_sec, 30)  # At least 30s per request cycle
        cr_cost = cr_billed_sec * (cr_pricing["gpu_per_sec"] + cr_pricing["cpu_per_sec"] + cr_pricing["mem_per_sec"])

        # Modal: billed ONLY for actual compute time (synthesis + small overhead)
        m_synth_sec = r.get("modal_t4_synth_avg_ms", r.get("modal_t4_e2e_avg_ms", 0)) / 1000
        # Modal bills from container start to idle timeout, but per-second
        # For a single request: synthesis time + small overhead
        m_billed_sec = m_synth_sec + 0.5  # Add 0.5s overhead
        m_cost = m_billed_sec * m_pricing["gpu_per_sec"]

        savings = ((cr_cost - m_cost) / cr_cost * 100) if cr_cost > 0 else 0

        print(f"  {r['test_case']:<25} ${cr_cost:>12.6f} ${m_cost:>12.6f} {savings:>12.1f}%")

    # Monthly projection
    print(f"\n  --- Monthly Cost Projection (500 requests/day) ---")
    for req_per_day in [100, 500, 2000]:
        # Cloud Run: instance stays warm, charged for idle too
        # Assume 5 min idle timeout per wake cycle, ~10 wake cycles/day for scattered requests
        wake_cycles = min(req_per_day, 50)  # Rough: requests cluster into wake cycles
        cr_daily_sec = wake_cycles * 300  # 5 min per wake cycle
        cr_monthly = cr_daily_sec * 30 * (cr_pricing["gpu_per_sec"] + cr_pricing["cpu_per_sec"] + cr_pricing["mem_per_sec"])

        # Modal: only synthesis time matters
        avg_synth_sec = 2.0  # ~2 seconds average per request
        m_daily_sec = req_per_day * (avg_synth_sec + 0.5)
        # But Modal also has idle timeout (30s). If requests are clustered, container stays warm
        # Add 30s idle timeout per burst (assume 10 bursts per day)
        m_daily_sec += min(wake_cycles, 30) * 30
        m_monthly = m_daily_sec * 30 * m_pricing["gpu_per_sec"]

        print(f"  {req_per_day:>5} req/day: Cloud Run = ${cr_monthly:>8.2f}/mo  |  Modal = ${m_monthly:>8.2f}/mo  |  Savings: ${cr_monthly - m_monthly:>8.2f}/mo")

    print()

    # Save
    output = os.path.join(os.path.dirname(__file__), "benchmark_results.json")
    with open(output, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  Results saved to: {output}")


if __name__ == "__main__":
    run_benchmark()
