"""Pure audio helpers (numpy + ffmpeg only, no torch) so they are unit-testable without the model."""
import re
import subprocess
import tempfile

import numpy as np

MAX_UPLOAD_BYTES = 30 * 1024 * 1024
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class AudioError(ValueError):
    pass


def decode(data: bytes, sr: int, max_sec: int = 600) -> np.ndarray:
    """Any container/codec ffmpeg understands -> float32 mono at `sr`."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise AudioError("file too large")
    with tempfile.NamedTemporaryFile(suffix=".bin") as f:
        f.write(data)
        f.flush()
        p = subprocess.run(["ffmpeg", "-v", "error", "-i", f.name, "-t", str(max_sec), "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"],
                           capture_output=True, timeout=60)
    if p.returncode != 0 or len(p.stdout) < 4 * sr // 5:
        raise AudioError("could not decode audio")
    return np.frombuffer(p.stdout, dtype="<f4").copy()


def basic_metrics(y: np.ndarray, sr: int = 16000) -> dict:
    """Duration, speech seconds, SNR estimate, clipping ratio and the 10th-percentile noise floor (dB). Same estimator the
    backend reference gate was calibrated on (backend/modal/chatterbox_clone.py)."""
    n = len(y)
    fl, hop = int(0.025 * sr), int(0.010 * sr)
    n_fr = max(1, 1 + (n - fl) // hop)
    idx = np.arange(fl)[None, :] + hop * np.arange(n_fr)[:, None]
    fr = y[np.minimum(idx, n - 1)]
    power = (fr ** 2).mean(1) + 1e-12
    db = 10 * np.log10(power)
    floor_db = float(np.percentile(db, 10))
    speech = (db > floor_db + 10) & (db > -55)
    speech_sec = float(speech.sum() * 0.01)
    if speech.any() and (~speech).sum() >= 5:
        ps = float(power[speech].mean())
        pn = float(power[db <= np.percentile(db, 20)].mean())
        snr = float(min(60.0, 10 * np.log10(ps / pn)))
    elif speech.any():
        snr = 60.0  # no quiet frames at all: cannot estimate a floor; treat as clean (heuristic)
    else:
        snr = 0.0
    return {"duration_sec": round(n / sr, 2), "speech_sec": round(speech_sec, 2), "snr_db": round(snr, 1),
            "clipping_ratio": round(float((np.abs(y) >= 0.999).mean()), 5), "floor_db": floor_db}


def chunks(text: str, chunk_chars: int = 300) -> list:
    sentences = re.split(r"(?<=[.!?。！？])\s+", text.strip())
    out, cur = [], ""
    for s in sentences:
        while len(s) > chunk_chars:  # hard-split run-on sentences at a space
            cut = s.rfind(" ", 0, chunk_chars)
            cut = cut if cut > 50 else chunk_chars
            out.append(s[:cut].strip())
            s = s[cut:].strip()
        if cur and len(cur) + 1 + len(s) > chunk_chars:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return [c for c in out if c]


def atempo_chain(speed: float) -> str:
    chain, s = [], speed
    while s > 2.0:
        chain.append("atempo=2.0")
        s /= 2.0
    while s < 0.5:
        chain.append("atempo=0.5")
        s /= 0.5
    chain.append(f"atempo={s:.4f}")
    return ",".join(chain)
