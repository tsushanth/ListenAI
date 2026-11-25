"""A long render must not stop the worker answering. Run:
python3 -m pytest tts-service-cpu-test/test_responsiveness.py   (needs numpy; the web framework and the model are stubbed)
"""
import asyncio
import threading
import time
import types

import numpy as np
import pytest

from test_chunking import m

STEP = 0.1  # seconds one model call takes


class SlowModel:
    def __init__(self):
        self.calls, self.active, self.most_active = [], 0, 0
        self._guard = threading.Lock()
        self.tokenizer = types.SimpleNamespace(phonemize=lambda text, lang: "a" * min(len(text), 100))

    def create(self, text, voice, speed, lang):
        with self._guard:
            self.active += 1
            self.most_active = max(self.most_active, self.active)
        time.sleep(STEP)
        with self._guard:
            self.active -= 1
            self.calls.append(text.split()[0])
        return np.ones(8, dtype=np.float32), 24000


@pytest.fixture
def model(monkeypatch):
    slow = SlowModel()
    monkeypatch.setattr(m, "load_kokoro", lambda: slow)
    monkeypatch.setattr(m, "StreamingResponse", lambda *a, **k: None)  # the web framework is stubbed
    monkeypatch.setattr(m, "_long_render", asyncio.Semaphore(1))
    return slow


def ask(word, parts):
    """A request whose text becomes `parts` model calls, every one starting with `word`."""
    sentence = (word + " ") * (390 // (len(word) + 1)) + "end."
    return types.SimpleNamespace(text=" ".join([sentence] * parts), voice_id="af_heart", language="en", speed=1.0, model="kokoro")


@pytest.mark.parametrize("handler", ["synthesize", "synthesize_long"])
def test_health_is_answered_while_a_render_is_running(model, handler):
    async def run():
        args = (ask("long", 10), types.SimpleNamespace(add_task=lambda *a: None)) if handler == "synthesize" else (ask("long", 10),)
        render = asyncio.create_task(getattr(m, handler)(*args))
        started = time.monotonic()
        await asyncio.sleep(STEP)
        health = await m.health()
        waited = time.monotonic() - started
        still_running = not render.done()
        await render
        return health, waited, still_running

    health, waited, still_running = asyncio.run(run())
    assert health["status"] == "healthy" and still_running and waited < 5 * STEP
    assert len(model.calls) == 10


def test_a_short_request_is_served_between_the_parts_of_a_long_one(model):
    async def run():
        long = asyncio.create_task(m.synthesize_long(ask("long", 12)))
        await asyncio.sleep(2 * STEP)
        await m.synthesize_long(ask("short", 1))
        finished_first = not long.done()
        await long
        return finished_first

    assert asyncio.run(run())
    assert model.calls.index("short") < 8 and model.calls.count("long") == 12


def test_the_model_is_never_used_by_two_requests_at_once(model):
    async def run():
        await asyncio.gather(*(m.synthesize_long(ask(f"r{i}", 3)) for i in range(4)))

    asyncio.run(run())
    assert model.most_active == 1 and len(model.calls) == 12


def test_only_one_long_render_is_in_progress_at_a_time(model):
    parts = m.LONG_RENDER_CHARS // 390 + 2

    async def run():
        await asyncio.gather(m.synthesize_long(ask("first", parts)), m.synthesize_long(ask("second", parts)))

    asyncio.run(run())
    assert model.calls == ["first"] * parts + ["second"] * parts


def test_turns_are_taken_in_the_order_asked():
    turn, order = m.TurnLock(), []

    def worker(name):
        with turn:
            order.append(name)

    with turn:
        threads = []
        for name in range(5):
            threads.append(threading.Thread(target=worker, args=(name,)))
            threads[-1].start()
            time.sleep(0.02)
    for t in threads:
        t.join(2)
    assert order == [0, 1, 2, 3, 4]


def test_a_failed_part_frees_the_turn(model, monkeypatch):
    def broken(*a, **k):
        raise ValueError("broken")

    good = model.create
    monkeypatch.setattr(model, "create", broken)
    monkeypatch.setattr(m.failure_reporter, "report", lambda *a: None)
    with pytest.raises(Exception):
        asyncio.run(m.synthesize_long(ask("bad", 2)))
    monkeypatch.setattr(model, "create", good)
    asyncio.run(asyncio.wait_for(m.synthesize_long(ask("after", 1)), 2))
    assert model.calls == ["after"]
