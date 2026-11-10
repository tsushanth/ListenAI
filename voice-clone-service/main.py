"""Entrypoint: `uvicorn main:app`. Loads the CPU engine (weights are baked into the image), builds the app, starts the retention sweeper."""
import threading
import time

from app import create_app, sweep_expired
from engine import ChatterboxEngine
from settings import Settings

settings = Settings.from_env()
engine = ChatterboxEngine(settings.model).load()
app = create_app(engine, settings)


def _sweeper():
    while True:
        try:
            sweep_expired(settings, engine)
        except Exception as e:  # noqa: BLE001
            print(f'{{"event":"sweep_failed","error":"{type(e).__name__}"}}', flush=True)
        time.sleep(6 * 3600)


threading.Thread(target=_sweeper, daemon=True).start()
