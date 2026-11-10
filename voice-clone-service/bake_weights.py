"""Runs at image build so a cold start never downloads weights (Turbo, Nano, ECAPA, AST)."""
import os

from chatterbox.tts_turbo import ChatterboxTurboTTS
from speechbrain.inference.speaker import EncoderClassifier
from transformers import ASTFeatureExtractor, ASTForAudioClassification

from engine import AST_MODEL, ECAPA_DIR, ECAPA_REPO, speechbrain_hf_compat

for nano in (False, True):
    m = ChatterboxTurboTTS.from_pretrained(device="cpu", nano=nano)
    print("baked", m.model_label, "sr", m.sr, flush=True)
speechbrain_hf_compat()
EncoderClassifier.from_hparams(ECAPA_REPO, savedir=ECAPA_DIR, run_opts={"device": "cpu"})
ASTFeatureExtractor.from_pretrained(AST_MODEL)
ASTForAudioClassification.from_pretrained(AST_MODEL)
print("baked ecapa+ast; HF cache:", os.environ.get("HF_HOME"), flush=True)
