"""Runs at image build so a cold start never downloads weights. BAKE_MODELS is a comma list of turbo,nano (default turbo)."""
import os

from speechbrain.inference.speaker import EncoderClassifier
from transformers import ASTFeatureExtractor, ASTForAudioClassification

from engine import AST_MODEL, ECAPA_DIR, ECAPA_REPO, ChatterboxEngine, speechbrain_hf_compat, turbo_snapshot

for name in os.environ.get("BAKE_MODELS", "turbo").split(","):
    path = turbo_snapshot(name.strip() == "nano", local_only=False)
    print("baked", name, path, flush=True)
speechbrain_hf_compat()
EncoderClassifier.from_hparams(ECAPA_REPO, savedir=ECAPA_DIR, run_opts={"device": "cpu"})
ASTFeatureExtractor.from_pretrained(AST_MODEL)
ASTForAudioClassification.from_pretrained(AST_MODEL)
print("baked ecapa+ast; HF cache:", os.environ.get("HF_HOME"), flush=True)
