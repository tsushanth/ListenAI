"""tts-service-modal keeps a copy of tts-service/kokoro_langs.py (the Modal image cannot reach outside its folder).
This fails if the copies drift. Run: python3 -m pytest tts-service-modal/test_kokoro_langs_sync.py"""
import os


def test_kokoro_langs_copies_are_identical():
    here = os.path.dirname(os.path.abspath(__file__))
    a = open(os.path.join(here, "kokoro_langs.py")).read()
    b = open(os.path.join(here, "..", "tts-service", "kokoro_langs.py")).read()
    assert a == b, "tts-service-modal/kokoro_langs.py differs from tts-service/kokoro_langs.py: copy one over the other"
