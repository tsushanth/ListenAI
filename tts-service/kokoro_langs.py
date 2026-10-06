"""Kokoro language routing shared by the TTS services (tts-service/ and tts-service-modal/ keep identical copies;
tts-service-modal/test_kokoro_langs_sync.py fails if they drift).

Kokoro picks its grapheme-to-phoneme front end from the KPipeline `lang_code`, which is also the first letter of
every voice id (a=American, b=British, e=Spanish, f=French, h=Hindi, i=Italian, p=Brazilian Portuguese,
j=Japanese, z=Mandarin). The services used to build only KPipeline(lang_code='a') and accept only [ab][fm]_ voice
ids, so Spanish/French/Hindi text was read by the English G2P (S3 dubbing report: 44% es / 68% fr ASR error as
shipped). Fix: one pipeline per lang_code, chosen from the voice id first and the request language second.

ja/zh are catalogued for completeness but need misaki[ja]/misaki[zh] which the images do not install; the dubbing
route does not offer them.
"""
import os
import re
from typing import Callable, Dict, List, Optional

LANG_CODES = ("a", "b", "e", "f", "h", "i", "j", "p", "z")

# Voice catalogue (Kokoro-82M VOICES.md). Non-English entries are what the dubbing route asks for.
KOKORO_VOICES: Dict[str, str] = {
    "af_heart": "American Female - Heart (default)", "af_bella": "American Female - Bella",
    "af_nicole": "American Female - Nicole", "af_sarah": "American Female - Sarah", "af_sky": "American Female - Sky",
    "am_adam": "American Male - Adam", "am_michael": "American Male - Michael",
    "bf_emma": "British Female - Emma", "bf_isabella": "British Female - Isabella",
    "bm_george": "British Male - George", "bm_lewis": "British Male - Lewis",
    "ef_dora": "Spanish Female - Dora", "em_alex": "Spanish Male - Alex", "em_santa": "Spanish Male - Santa",
    "ff_siwis": "French Female - Siwis",
    "hf_alpha": "Hindi Female - Alpha", "hf_beta": "Hindi Female - Beta",
    "hm_omega": "Hindi Male - Omega", "hm_psi": "Hindi Male - Psi",
    "if_sara": "Italian Female - Sara", "im_nicola": "Italian Male - Nicola",
    "pf_dora": "Portuguese Female - Dora", "pm_alex": "Portuguese Male - Alex", "pm_santa": "Portuguese Male - Santa",
}

_DEFAULT_VOICE = {"a": "af_heart", "b": "bf_emma", "e": "em_alex", "f": "ff_siwis", "h": "hm_omega", "i": "im_nicola", "p": "pm_alex"}

_ISO_TO_LANG_CODE = {
    "en": "a", "en-us": "a", "en-gb": "b", "es": "e", "fr": "f", "hi": "h", "it": "i", "pt": "p", "pt-br": "p",
    "ja": "j", "zh": "z",
}

_VOICE_RE = re.compile(r"^[a-z][fm]_[a-z0-9]+$")


def is_direct_kokoro_voice(voice_id: str) -> bool:
    return bool(voice_id) and bool(_VOICE_RE.match(voice_id)) and voice_id in KOKORO_VOICES


def default_voice(lang_code: str) -> str:
    return _DEFAULT_VOICE.get(lang_code, "af_heart")


def lang_code_for(voice_id: Optional[str], language: Optional[str]) -> str:
    """KPipeline lang_code for a request. A known native voice id decides; otherwise the language; otherwise 'a'."""
    if voice_id and is_direct_kokoro_voice(voice_id):
        return voice_id[0]
    key = (language or "").strip().lower().replace("_", "-")
    if key in _ISO_TO_LANG_CODE:
        return _ISO_TO_LANG_CODE[key]
    base = key.split("-")[0]
    return _ISO_TO_LANG_CODE.get(base, "a")


class NonEnglishDisabled(Exception):
    """Kokoro non-English synthesis was requested while KOKORO_NON_ENGLISH_ENABLED is off (owner voice-provenance rule)."""


def non_english_enabled(env=None) -> bool:
    """Kokoro es/fr/hi/it/pt/ja/zh synthesis is OFF unless KOKORO_NON_ENGLISH_ENABLED is 1/true/yes/on.

    Owner rule 2026-10-06 (voice provenance): Kokoro's non-English voices have no data statement, so they must not serve
    traffic by default. English (a/b) is unaffected. Set the flag only for local/dev work."""
    env = os.environ if env is None else env
    return str(env.get("KOKORO_NON_ENGLISH_ENABLED", "")).strip().lower() in ("1", "true", "yes", "on")


def plan(voice: str, language: Optional[str], voice_is_explicit: bool, allow_non_english: Optional[bool] = None):
    """(voice, lang_code) to synthesize with.

    - A voice the caller asked for by its native Kokoro id (voice_is_explicit) decides the lang_code: it can only
      sound right with its own G2P, whatever `language` says (the dubbing route used to send 'en-US' with everything).
    - Otherwise (builtin alias such as 'default'/'adam', already resolved to an English voice) the request language
      decides: a non-English language swaps in that language's default voice, so non-English text is never read
      by an English voice; English aliases keep their own accent (American or British).
    """
    allowed = non_english_enabled() if allow_non_english is None else allow_non_english
    chosen, lc = _plan(voice, language, voice_is_explicit)
    if not is_english(lc) and not allowed:
        raise NonEnglishDisabled(
            f"Kokoro non-English synthesis (voice {chosen!r}, lang_code {lc!r}) is disabled on this service: set "
            "KOKORO_NON_ENGLISH_ENABLED=1 to enable it (voice-provenance rule: off by default)."
        )
    return chosen, lc


def _plan(voice: str, language: Optional[str], voice_is_explicit: bool):
    if voice_is_explicit and is_direct_kokoro_voice(voice):
        return voice, voice[0]
    lang_code = lang_code_for(None, language)
    if is_english(lang_code) and is_english(voice[:1]):
        return voice, voice[0]
    if voice[:1] == lang_code:
        return voice, lang_code
    return default_voice(lang_code), lang_code


class PipelineCache:
    """Lazily builds and keeps one KPipeline per lang_code (each holds its own G2P; the 82M model weights are shared on disk)."""

    def __init__(self, factory: Callable[[str], object]):
        self._factory = factory
        self._pipes: Dict[str, object] = {}

    def get(self, lang_code: str):
        if lang_code not in self._pipes:
            self._pipes[lang_code] = self._factory(lang_code)
        return self._pipes[lang_code]

    def loaded(self) -> List[str]:
        return sorted(self._pipes)


def is_english(lang_code: str) -> bool:
    return lang_code in ("a", "b")


def preprocess_non_english(text: str) -> str:
    """Text cleanup before KPipeline for non-English text: whitespace normalisation and a sentence-final mark.
    The services' English pronunciation fixes ('in' -> 'inn', 'vs' -> 'versus', ...) must NOT run on other
    languages (they would corrupt e.g. Italian 'in'), so each service applies its own English preprocessing
    only when is_english(lang_code)."""
    text = re.sub(r"\n\s*\n+", ". ", text)
    text = re.sub(r"\n", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if text and text[-1] not in ".!?…।。！？":
        text += "."
    return text
