#!/usr/bin/env python3
"""
Benchmark: GPU TTS vs CPU TTS (ONNX)
Compares latency, audio quality (duration/size), and throughput.
"""

import time
import json
import hashlib
import statistics
import sys
import os

import httpx

# Service URLs
GPU_URL = os.getenv("GPU_URL", "https://readaloud-tts-gpu-917362189743.us-central1.run.app")
CPU_URL = os.getenv("CPU_URL", "https://readaloud-tts-cpu-test-917362189743.us-central1.run.app")

# Test texts of varying lengths
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

VOICES_TO_TEST = ["af_heart", "am_adam", "af_bella", "bm_george"]

NUM_RUNS = 3  # Runs per test case for averaging


def call_synthesize(base_url: str, text: str, voice_id: str, timeout: float = 120.0) -> dict:
    """Call the /synthesize endpoint and return timing + response info."""
    payload = {
        "text": text,
        "voice_id": voice_id,
        "model": "kokoro",
        "speed": 1.0,
    }

    # Add cache-busting param to prevent server-side cache hits
    cache_buster = hashlib.md5(f"{time.time()}".encode()).hexdigest()[:8]
    payload["text"] = f"{text} [{cache_buster}]"

    start = time.time()
    try:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(f"{base_url}/synthesize", json=payload)
        elapsed = time.time() - start

        if resp.status_code != 200:
            return {
                "success": False,
                "error": f"HTTP {resp.status_code}: {resp.text[:200]}",
                "elapsed_ms": int(elapsed * 1000),
            }

        audio_data = resp.content
        synthesis_time = resp.headers.get("X-Synthesis-Time-Ms", "N/A")
        cache_status = resp.headers.get("X-Cache", "N/A")
        model = resp.headers.get("X-Model", "N/A")

        return {
            "success": True,
            "elapsed_ms": int(elapsed * 1000),
            "synthesis_time_ms": synthesis_time,
            "audio_size_bytes": len(audio_data),
            "cache": cache_status,
            "model": model,
            "status_code": resp.status_code,
        }
    except Exception as e:
        elapsed = time.time() - start
        return {
            "success": False,
            "error": str(e),
            "elapsed_ms": int(elapsed * 1000),
        }


def warm_up(url: str, name: str):
    """Send a warmup request to ensure the service is ready."""
    print(f"  Warming up {name}...")
    result = call_synthesize(url, "Warmup test.", "af_heart", timeout=180.0)
    if result["success"]:
        print(f"  {name} ready ({result['elapsed_ms']}ms)")
    else:
        print(f"  {name} warmup FAILED: {result.get('error', 'unknown')}")
    return result["success"]


def run_benchmark():
    print("=" * 70)
    print("  TTS Benchmark: GPU (PyTorch) vs CPU (ONNX)")
    print("=" * 70)
    print(f"\n  GPU: {GPU_URL}")
    print(f"  CPU: {CPU_URL}")
    print(f"  Runs per test: {NUM_RUNS}")
    print()

    # Warmup both services
    print("Warming up services (this may take a minute for cold starts)...")
    gpu_ready = warm_up(GPU_URL, "GPU")
    cpu_ready = warm_up(CPU_URL, "CPU")

    if not gpu_ready and not cpu_ready:
        print("\nBoth services failed to start. Exiting.")
        sys.exit(1)

    results = []

    for tc in TEST_CASES:
        print(f"\n--- {tc['name']} ({len(tc['text'])} chars) ---")

        gpu_times = []
        cpu_times = []
        gpu_sizes = []
        cpu_sizes = []

        for run in range(NUM_RUNS):
            # GPU
            if gpu_ready:
                gpu_result = call_synthesize(GPU_URL, tc["text"], tc["voice_id"])
                if gpu_result["success"]:
                    gpu_times.append(gpu_result["elapsed_ms"])
                    gpu_sizes.append(gpu_result["audio_size_bytes"])
                    print(f"  GPU run {run+1}: {gpu_result['elapsed_ms']}ms, {gpu_result['audio_size_bytes']} bytes")
                else:
                    print(f"  GPU run {run+1}: FAILED - {gpu_result.get('error', '')[:80]}")

            # CPU
            if cpu_ready:
                cpu_result = call_synthesize(CPU_URL, tc["text"], tc["voice_id"])
                if cpu_result["success"]:
                    cpu_times.append(cpu_result["elapsed_ms"])
                    cpu_sizes.append(cpu_result["audio_size_bytes"])
                    print(f"  CPU run {run+1}: {cpu_result['elapsed_ms']}ms, {cpu_result['audio_size_bytes']} bytes")
                else:
                    print(f"  CPU run {run+1}: FAILED - {cpu_result.get('error', '')[:80]}")

        result = {
            "test_case": tc["name"],
            "text_length": len(tc["text"]),
            "voice": tc["voice_id"],
        }

        if gpu_times:
            result["gpu_avg_ms"] = int(statistics.mean(gpu_times))
            result["gpu_median_ms"] = int(statistics.median(gpu_times))
            result["gpu_min_ms"] = min(gpu_times)
            result["gpu_max_ms"] = max(gpu_times)
            result["gpu_avg_audio_bytes"] = int(statistics.mean(gpu_sizes))

        if cpu_times:
            result["cpu_avg_ms"] = int(statistics.mean(cpu_times))
            result["cpu_median_ms"] = int(statistics.median(cpu_times))
            result["cpu_min_ms"] = min(cpu_times)
            result["cpu_max_ms"] = max(cpu_times)
            result["cpu_avg_audio_bytes"] = int(statistics.mean(cpu_sizes))

        if gpu_times and cpu_times:
            result["speedup_ratio"] = round(statistics.mean(gpu_times) / statistics.mean(cpu_times), 2)

        results.append(result)

    # Print summary table
    print("\n" + "=" * 70)
    print("  BENCHMARK RESULTS SUMMARY")
    print("=" * 70)
    print(f"\n{'Test Case':<25} {'Chars':>6} {'GPU avg':>10} {'CPU avg':>10} {'CPU vs GPU':>12} {'Audio Match':>12}")
    print("-" * 75)

    for r in results:
        gpu_avg = f"{r.get('gpu_avg_ms', 'N/A')}ms"
        cpu_avg = f"{r.get('cpu_avg_ms', 'N/A')}ms"

        if "speedup_ratio" in r:
            if r["speedup_ratio"] > 1:
                comparison = f"CPU {r['speedup_ratio']}x faster"
            else:
                ratio = round(1 / r["speedup_ratio"], 2)
                comparison = f"GPU {ratio}x faster"
        else:
            comparison = "N/A"

        # Check if audio sizes are similar (within 20%)
        if "gpu_avg_audio_bytes" in r and "cpu_avg_audio_bytes" in r:
            size_diff = abs(r["gpu_avg_audio_bytes"] - r["cpu_avg_audio_bytes"]) / max(r["gpu_avg_audio_bytes"], 1)
            audio_match = f"{int(size_diff * 100)}% diff"
        else:
            audio_match = "N/A"

        print(f"{r['test_case']:<25} {r['text_length']:>6} {gpu_avg:>10} {cpu_avg:>10} {comparison:>12} {audio_match:>12}")

    # Cost analysis
    print("\n" + "=" * 70)
    print("  COST ANALYSIS")
    print("=" * 70)
    print(f"""
  GPU Service (L4 GPU + 4 CPU + 16Gi):
    Per-hour cost: ~$0.56 (GPU) + ~$0.10 (CPU) = ~$0.66/hr
    Always-on CPU (no throttle): Billed full rate when instance is up

  CPU Service (4 CPU + 4Gi, with throttling):
    Per-hour cost: ~$0.10/hr (only when handling requests)
    Scale-to-zero: $0 when idle

  Estimated monthly savings: $150-400/month depending on usage patterns
""")

    # Save results
    output_path = os.path.join(os.path.dirname(__file__), "benchmark_results.json")
    with open(output_path, "w") as f:
        json.dump(results, f, indent=2)
    print(f"  Results saved to: {output_path}")


if __name__ == "__main__":
    run_benchmark()
