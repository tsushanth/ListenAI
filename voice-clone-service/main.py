"""Entrypoint: `uvicorn main:app`. Loads the CPU engine (weights are baked into the image), builds the app, starts the retention sweeper."""
import os
import threading
import time

from app import create_app, sweep_expired
from engine import ChatterboxEngine
from settings import Settings

settings = Settings.from_env()
engine = ChatterboxEngine(settings.model)
app = create_app(engine, settings)  # listens at once; requests wait on engine.ready (cold start = added latency, not a 503)


def _load():
    try:
        engine.load()
        engine.ready.set()
        print(f'{{"event":"engine_ready","load_s":{engine.load_s}}}', flush=True)
    except Exception as e:  # noqa: BLE001
        engine.load_error = type(e).__name__
        print(f'{{"event":"engine_load_failed","error":"{type(e).__name__}"}}', flush=True)
        os._exit(1)  # let Fly restart the machine instead of serving 503s forever


threading.Thread(target=_load, daemon=True).start()


def _sweeper():
    while True:
        try:
            sweep_expired(settings, engine)
        except Exception as e:  # noqa: BLE001
            print(f'{{"event":"sweep_failed","error":"{type(e).__name__}"}}', flush=True)
        time.sleep(6 * 3600)


threading.Thread(target=_sweeper, daemon=True).start()
