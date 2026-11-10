#!/usr/bin/env python3
"""Try the voice-clone service end to end from the command line (stdlib only).

    python3 try_clone.py --clip ~/path/my-voice.m4a --i-am-the-speaker \
        --text "Hello, this is a test of my cloned voice."

What it does: creates a voice from the clip, submits an async synthesis job, long-polls until it finishes, saves the WAV, then
DELETES the voice (add --keep to keep it). It never opens the file for you. The service token is read from
~/.listenai_voice_clone_token (override with --token-file) and is never printed.

Consent: this talks to the service directly, so it bypasses the backend's consent flow. Use it ONLY with a recording of your own
voice (or a synthetic/public-domain clip) and pass --i-am-the-speaker to say so; the attestation id is stored with the voice.
The first request after the service has been idle takes a while (the machine starts and loads the model).
"""
import argparse
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid


def multipart(fields: dict, files: dict):
    boundary = "----vc" + uuid.uuid4().hex
    out = []
    for k, v in fields.items():
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, (name, data, ctype) in files.items():
        out.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\nContent-Type: {ctype}\r\n\r\n'.encode() + data + b"\r\n")
    out.append(f"--{boundary}--\r\n".encode())
    return b"".join(out), f"multipart/form-data; boundary={boundary}"


def call(method, url, token, body=None, ctype=None, timeout=900):
    req = urllib.request.Request(url, data=body, method=method, headers={"Authorization": f"Bearer {token}", **({"Content-Type": ctype} if ctype else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True, help="10-30 s recording of the voice to clone (m4a/wav/mp3/...)")
    ap.add_argument("--text", default="Hello. This is a short test of a cloned voice, generated on a small CPU machine.")
    ap.add_argument("--url", default="https://listenai-voice-clone.fly.dev")
    ap.add_argument("--token-file", default=os.path.expanduser("~/.listenai_voice_clone_token"))
    ap.add_argument("--out", default=None, help="output WAV (default ~/Documents/voice-clone-samples-2026-11-10/clone-<time>.wav)")
    ap.add_argument("--keep", action="store_true", help="keep the voice on the server (default: delete it when done)")
    ap.add_argument("--i-am-the-speaker", action="store_true", help="attest the clip is your own voice (or synthetic/public domain)")
    a = ap.parse_args()
    if not a.i_am_the_speaker:
        sys.exit("Refusing: pass --i-am-the-speaker to confirm the clip is your own voice (or synthetic / public domain).")
    token = open(a.token_file).read().strip()
    clip = os.path.expanduser(a.clip)
    data = open(clip, "rb").read()
    out = a.out or os.path.expanduser(f"~/Documents/voice-clone-samples-2026-11-10/clone-{time.strftime('%H%M%S')}.wav")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    base, vid = a.url.rstrip("/"), str(uuid.uuid4())
    t0 = time.time()
    body, ct = multipart({"voice_id": vid, "language": "en", "consent_id": f"cli-self-attestation-{time.strftime('%Y%m%d')}"},
                         {"reference": (os.path.basename(clip), data, mimetypes.guess_type(clip)[0] or "application/octet-stream")})
    st, _, resp = call("POST", f"{base}/voices", token, body, ct)
    print(f"create voice: HTTP {st} in {time.time() - t0:.0f}s {resp[:200].decode(errors='replace') if st != 200 else ''}")
    if st != 200:
        sys.exit(1)
    try:
        t1 = time.time()
        st, _, resp = call("POST", f"{base}/voices/{vid}/jobs", token, json.dumps({"text": a.text, "language": "en"}).encode(), "application/json")
        if st != 202:
            sys.exit(f"submit job: HTTP {st} {resp[:200].decode(errors='replace')}")
        job = json.loads(resp)["job_id"]
        while True:  # long-poll: each request holds the connection open, which also keeps the machine awake
            st, _, resp = call("GET", f"{base}/jobs/{job}?wait=50", token, timeout=120)
            j = json.loads(resp)
            if j["status"] in ("done", "error"):
                break
        if j["status"] != "done":
            sys.exit(f"job failed: {j}")
        st, hdr, audio = call("GET", f"{base}/jobs/{job}/audio", token)
        open(out, "wb").write(audio)
        print(f"saved {out} ({len(audio)} bytes); audio {j['audio_seconds']} s, generated in {j['gen_seconds']} s "
              f"(RTF {j['gen_seconds'] / max(j['audio_seconds'], 0.01):.1f}), total {time.time() - t1:.0f}s, Perth watermark score {j['watermark_score']}")
    finally:
        if not a.keep:
            st, _, _ = call("DELETE", f"{base}/voices/{vid}", token)
            print(f"deleted voice: HTTP {st}")
        else:
            print(f"kept voice {vid}")


if __name__ == "__main__":
    main()
