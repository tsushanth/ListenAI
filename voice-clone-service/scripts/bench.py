#!/usr/bin/env python3
"""Objective benchmark against a running service: creates a voice from --clip, runs short/medium/long jobs, prints RTF per length,
saves the WAVs, deletes the voice. Stdlib only; reuses try_clone helpers. Never prints the token."""
import argparse
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(__file__))
from try_clone import call, multipart  # noqa: E402

TEXTS = {
    "short": "Thanks for calling. I can help you with that right away.",
    "medium": ("The morning train pulled slowly out of the station while the town was still waking up. A baker lifted the shutters, "
               "and a child waved from a window as the river carried the first light toward the sea."),
    "long": ("Good morning, and welcome. Today I want to walk you through how the new reading feature works. First, you choose a document, "
             "and the app prepares it so that it can be read aloud in a clear, steady voice. Second, you can adjust the speed to suit "
             "the way you listen, whether you are commuting, cooking, or simply resting your eyes. Third, if you have created your own "
             "voice, the app can read in it, and you can delete that voice at any time. We designed each step to stay out of your way, "
             "so that the only thing you notice is the story or the article itself. Thank you for listening, and enjoy the rest of your day."),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--url", default="https://listenai-voice-clone.fly.dev")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.listenai_voice_clone_token"))
    ap.add_argument("--outdir", default=os.path.expanduser("~/Documents/voice-clone-samples-2026-11-10"))
    ap.add_argument("--sizes", default="short,medium,long")
    a = ap.parse_args()
    token, base, vid = open(a.token_file).read().strip(), a.url.rstrip("/"), str(uuid.uuid4())
    os.makedirs(a.outdir, exist_ok=True)
    t0 = time.time()
    body, ct = multipart({"voice_id": vid, "language": "en", "consent_id": "bench-synthetic-reference"},
                         {"reference": (os.path.basename(a.clip), open(a.clip, "rb").read(), "audio/wav")})
    st, _, resp = call("POST", f"{base}/voices", token, body, ct)
    print(f"create voice HTTP {st} in {time.time() - t0:.1f}s (includes cold start if the machine was stopped) {resp[:120].decode(errors='replace') if st != 200 else ''}")
    if st != 200:
        sys.exit(1)
    rows = []
    try:
        for size in a.sizes.split(","):
            text = TEXTS[size]
            t1 = time.time()
            st, _, resp = call("POST", f"{base}/voices/{vid}/jobs", token, json.dumps({"text": text, "language": "en"}).encode(), "application/json")
            job = json.loads(resp)["job_id"]
            while True:
                st, _, resp = call("GET", f"{base}/jobs/{job}?wait=50", token, timeout=120)
                j = json.loads(resp)
                if j["status"] in ("done", "error"):
                    break
            if j["status"] != "done":
                print(size, "FAILED", j)
                continue
            st, hdr, audio = call("GET", f"{base}/jobs/{job}/audio", token)
            path = os.path.join(a.outdir, f"bench-{size}-{time.strftime('%H%M%S')}.wav")
            open(path, "wb").write(audio)
            rows.append((size, len(text), j["audio_seconds"], j["gen_seconds"], time.time() - t1, j["watermark_score"], path))
        print(f"{'size':7} {'chars':>5} {'audio_s':>8} {'gen_s':>7} {'wall_s':>7} {'RTF':>5} {'wm':>6}")
        for size, chars, au, gen, wall, wm, path in rows:
            print(f"{size:7} {chars:5d} {au:8.1f} {gen:7.1f} {wall:7.1f} {gen / max(au, 0.01):5.2f} {wm:6.3f}  {path}")
    finally:
        st, _, _ = call("DELETE", f"{base}/voices/{vid}", token)
        print("deleted voice HTTP", st)


if __name__ == "__main__":
    main()
