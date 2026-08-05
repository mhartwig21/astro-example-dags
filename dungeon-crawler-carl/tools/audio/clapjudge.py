"""
CLAP JUDGE — the closest this repo gets to an ear that is not the owner's.

WHY THIS EXISTS
---------------
Every audio instrument in tools/audio/ measures COMPLIANCE: measure.mjs checks
loudness, peak, seam delta and silence share; contactsheet.mjs renders shape and
envelope so a reviewer can SEE sameness. None of them can say whether a clip is
the sound it was supposed to be, because none of them know what any sound MEANS.
That gap is exactly how the audio track shipped an 8.8 audit with zero blockers
while thirteen abilities cast in silence and 620MB of PCM sat resident: the
audit scored what it enumerated, accurately, and never asked the other question.

CLAP (Contrastive Language-Audio Pretraining, LAION) embeds audio and text into
ONE shared space, trained on human-labelled audio-text pairs. So it can answer
two questions that a spectrogram cannot:

  1. BRIEF MATCH — "is this clip the thing the sonic brief asked for?"  Score the
     clip against its own intent line AND against every OTHER ability's intent
     line. A clip that matches its own brief best is on target. A clip whose top
     match is some other ability's brief is mislabelled, generic, or wrong — and
     that is a finding no LUFS table can produce.

  2. HOUSE TONE — "does this belong in this game?"  Embed the already-shipped
     SFX, take their centroid, and measure how far each new clip sits from it.
     A new set that clusters with the shipped library shares its voice; a set
     that floats off on its own is a different game's library, however nice each
     clip is alone.

WHAT IT IS NOT
--------------
It is not an ear and it does not have taste. It reports SEMANTIC AGREEMENT — how
close a clip lands to a description in a learned space. A clip can score well and
still be unpleasant, thin, or badly mixed. "Does it sound good" remains the
owner's, and the audition sheet exists to make that verdict cost ninety seconds.
No caller of this script may report a CLAP score as a quality verdict.

CALIBRATION — READ THIS BEFORE TRUSTING A NUMBER
------------------------------------------------
`brief` was smoke-tested against eight SHIPPED clips whose identity is not in
doubt, with unambiguous descriptions ("a cash register ringing", "a crowd of
people reacting"). Corrected result: 3 of 6 on the re-run.

  till        -> "a cash register ringing"   p=0.819  OK
  smash_clay  -> "a ceramic pot shattering"  p=0.661  OK
  door_close  -> "a heavy door closing"      p=0.530  OK
  crowd       -> "fire igniting"             p=0.436  MISS
  smash_wood  -> "a heavy door closing"      p=0.467  MISS
  apply_burn  -> "a ceramic pot shattering"  p=0.300  MISS

So `brief` is a WEAK signal on this repo's audio, and the reason is structural:
CLAP is trained on AudioSet/Clotho-style multi-second real-world recordings, and
our SFX are 100-500ms synthesized blips — out of distribution. A single `brief`
result is a HINT worth investigating, never a finding on its own. Report it with
its probability, and never let it alone fail a clip.

`house` is the mode to trust. It compares audio to audio only — no cross-modal
alignment, so the failure mode above cannot occur — and asks the relative
question ("does this new clip sit where the shipped library sits") rather than
an absolute one. Outlier detection against the shipped set is what this tool is
genuinely good for.

USAGE
-----
  python tools/audio/clapjudge.py brief  --spec briefs.json
  python tools/audio/clapjudge.py house  --new "public/audio/sfx/cast_*.ogg" \
                                         --ref "public/audio/sfx/impact.ogg" ...

briefs.json: {"cast_cataclysm": {"file": "public/audio/sfx/cast_cataclysm.ogg",
                                 "intent": "a deep slab of stone splitting, dry, no reverb tail"}}
"""
from __future__ import annotations

import argparse
import glob
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

# CLAP's audio tower is trained at 48kHz. Our SFX are rendered at 48kHz
# (tools/audio/lib.mjs SR = 48000), so no resample is needed for the cast clips —
# but ffmpeg is asked for 48k mono anyway so a stray 44.1k reference file (e.g.
# battle_winter.ogg) cannot silently shift every feature it contributes to.
SR = 48000
MODEL_ID = "laion/clap-htsat-unfused"

# CLAP truncates long audio; ten seconds is far beyond any cast cue and keeps the
# reference set (which includes a few longer stingers) from dominating on length.
MAX_SECONDS = 10


def decode(path: str) -> np.ndarray:
    """ogg -> float32 mono @48k via ffmpeg. Raises with ffmpeg's own message."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1",
         "-ar", str(SR), "-t", str(MAX_SECONDS), "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed on {path}: {proc.stderr.decode(errors='replace')}")
    a = np.frombuffer(proc.stdout, dtype=np.float32)
    if a.size == 0:
        raise RuntimeError(f"{path} decoded to zero samples")
    return a.copy()


def load_model():
    import torch
    from transformers import ClapModel, ClapProcessor
    torch.set_grad_enabled(False)
    model = ClapModel.from_pretrained(MODEL_ID).eval()
    proc = ClapProcessor.from_pretrained(MODEL_ID)
    return torch, model, proc


def embed_audio(torch, model, proc, paths: list[str]) -> np.ndarray:
    """One L2-normalised row per path, in the order given."""
    rows = []
    for p in paths:
        # transformers v5 renamed the kwarg `audios` -> `audio`.
        inputs = proc(audio=decode(p), sampling_rate=SR, return_tensors="pt")
        rows.append(_norm(_feat(model.get_audio_features(**inputs))).squeeze(0).numpy())
    return np.stack(rows)


def _feat(out):
    """transformers v5 may return a ModelOutput here instead of a bare tensor."""
    if hasattr(out, "shape"):
        return out
    for attr in ("pooler_output", "audio_embeds", "text_embeds", "last_hidden_state"):
        v = getattr(out, attr, None)
        if v is not None and hasattr(v, "shape"):
            return v if v.dim() == 2 else v.mean(dim=1)
    raise TypeError(f"cannot find a feature tensor on {type(out).__name__}")


def _norm(t):
    return t / t.norm(dim=-1, keepdim=True)


def embed_text(torch, model, proc, texts: list[str]) -> np.ndarray:
    inputs = proc(text=texts, return_tensors="pt", padding=True)
    return _norm(_feat(model.get_text_features(**inputs))).numpy()


def cmd_brief(args) -> int:
    spec = json.loads(Path(args.spec).read_text(encoding="utf8"))
    ids = list(spec.keys())
    files = [spec[i]["file"] for i in ids]
    intents = [spec[i]["intent"] for i in ids]

    torch, model, proc = load_model()
    # THE AUTHORITATIVE PATH. An earlier version of this file scored
    # get_audio_features() against get_text_features(), which in transformers v5
    # returns each tower's PRE-PROJECTION pooler output. Both are 512-wide, so the
    # arithmetic runs and the table prints — it just compares vectors that live in
    # different spaces, and the smoke test came back 1/8 (noise). The full forward
    # applies both projections and returns the contrastive logits the model was
    # actually trained on. Do not "simplify" this back to the feature getters.
    S = np.zeros((len(ids), len(ids)), dtype=np.float64)
    for i, f in enumerate(files):
        inp = proc(text=intents, audio=decode(f), sampling_rate=SR,
                   return_tensors="pt", padding=True)
        S[i] = model(**inp).logits_per_audio.softmax(dim=-1).squeeze(0).numpy()

    print(f"\n{'clip':<22} {'own brief':>10} {'best match':<22} {'best':>7}  verdict")
    print("-" * 84)
    results = []
    onTarget = 0
    for i, cid in enumerate(ids):
        own = float(S[i, i])
        j = int(np.argmax(S[i]))
        best = float(S[i, j])
        # ON TARGET means the clip's own brief is its best match. Anything else
        # says the render is closer to a DIFFERENT ability's description, which is
        # the mislabelling/genericness finding this mode exists to surface.
        ok = j == i
        onTarget += ok
        margin = own - float(np.max(np.delete(S[i], i)))
        verdict = "on target" if ok else f"reads as {ids[j]}"
        if ok and margin < 0.02:
            verdict = "on target, but barely (ambiguous)"
        print(f"{cid:<22} {own:>10.4f} {ids[j]:<22} {best:>7.4f}  {verdict}")
        results.append({"id": cid, "ownScore": own, "bestMatch": ids[j],
                        "bestScore": best, "margin": margin, "onTarget": ok})

    print(f"\n{onTarget}/{len(ids)} clips match their own brief better than any other.")
    print("NOTE: this is SEMANTIC AGREEMENT, not quality. A clip can score well and still\n"
          "      be thin, harsh or unpleasant. The owner's ear is the only quality verdict.")
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2), encoding="utf8")
        print(f"wrote {args.json}")
    return 0


def cmd_house(args) -> int:
    new = sorted({p for g in args.new for p in glob.glob(g)})
    ref = sorted({p for g in args.ref for p in glob.glob(g)})
    if not new or not ref:
        print(f"need both sets (new={len(new)}, ref={len(ref)})", file=sys.stderr)
        return 2

    torch, model, proc = load_model()
    N = embed_audio(torch, model, proc, new)
    R = embed_audio(torch, model, proc, ref)

    centroid = R.mean(axis=0)
    centroid /= np.linalg.norm(centroid)

    # The reference set's OWN spread is the yardstick. "Far from the house" only
    # means something relative to how far the house already spreads from itself —
    # a fixed threshold would be a number pulled from nowhere.
    ref_sims = R @ centroid
    lo, mean = float(ref_sims.min()), float(ref_sims.mean())
    print(f"\nreference set: {len(ref)} clips, similarity to their own centroid "
          f"mean {mean:.4f}, min {lo:.4f}")
    print("(the min is the bar: a new clip further out than the house's own most "
          "distant member is an outlier)\n")

    print(f"{'clip':<26} {'to house':>9}  {'nearest shipped':<22} {'sim':>7}  flag")
    print("-" * 82)
    out = []
    for i, p in enumerate(new):
        s = float(N[i] @ centroid)
        sims = N[i] @ R.T
        k = int(np.argmax(sims))
        flag = "" if s >= lo else "OUTLIER"
        print(f"{Path(p).stem:<26} {s:>9.4f}  {Path(ref[k]).stem:<22} "
              f"{float(sims[k]):>7.4f}  {flag}")
        out.append({"file": p, "toHouse": s, "nearest": ref[k],
                    "nearestSim": float(sims[k]), "outlier": s < lo})

    n_out = sum(o["outlier"] for o in out)
    print(f"\n{n_out}/{len(new)} clips sit further from the house voice than the "
          f"shipped library's own most distant member.")
    print("NOTE: distance from the house is a COHERENCE signal, not a quality one. A\n"
          "      deliberate outlier (an ultimate that should feel foreign) is a design\n"
          "      choice, not automatically a defect — but it should be a CHOSEN one.")
    if args.json:
        Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf8")
        print(f"wrote {args.json}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("brief", help="score each clip against its intended description")
    b.add_argument("--spec", required=True, help="json: {id: {file, intent}}")
    b.add_argument("--json", help="write results here")
    b.set_defaults(fn=cmd_brief)

    h = sub.add_parser("house", help="measure new clips against the shipped library's voice")
    h.add_argument("--new", nargs="+", required=True, help="glob(s) for the new clips")
    h.add_argument("--ref", nargs="+", required=True, help="glob(s) for shipped reference clips")
    h.add_argument("--json", help="write results here")
    h.set_defaults(fn=cmd_house)

    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    raise SystemExit(main())
