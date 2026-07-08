# Plan v2 — Large-Scale AI-Generated Animated Asset Library in KayKit Style

> Revision of the v1 plan after review. Key change of goal: the target is a **much larger
> ANIMATED asset set than KayKit provides**, produced **end-to-end through AI**. That makes
> animated characters/creatures the core deliverable, not a Phase-3 afterthought, and it makes
> library-scale consistency and throughput first-class requirements.

---

## 1. Goal (revised)

Produce an asset library **substantially larger than the full KayKit catalog** — animated
characters and creatures plus supporting props/environment — in a unified KayKit-like style
(low-poly, single shared gradient atlas, flat/soft shading, warm palette), where **every stage is
AI or script: no manual modeling, texturing, rigging, or keyframing.**

Success at scale means three consistencies, not one:
1. **Visual** — everything reads as one art style (shared atlas + palette).
2. **Skeletal** — all characters share an animation system (any clip plays on any character).
3. **Structural** — uniform scale, pivots, naming, and file layout so the library is usable.

v1 only seriously addressed #1. #2 is what makes KayKit's *character* packs valuable.

---

## 2. Three-layer consistency architecture (the core revision)

Enforce style where each kind of AI is strongest, and finish with deterministic code:

**Layer 1 — Style at the 2D stage (new in v2).**
Don't ask the 3D generator to hold the style. Generate a **2D concept image in house style
first** (image models handle style references far better than 3D generators), then feed that to
Image-to-3D. Start with style-reference conditioning using KayKit renders as the reference; if
outputs drift across hundreds of assets, train a small **LoRA on renders of KayKit assets**
(CC0 makes this legally clean) for a locked-in house look. Characters are generated **front-facing,
T-pose** by prompt for rig quality.

**Layer 2 — Geometry from image (as v1).**
Meshy Image-to-3D, Low-Poly mode, fixed poly budget per asset class. Image anchoring is what keeps
proportions KayKit-chunky.

**Layer 3 — Deterministic palette snap (replaces v1's segmentation approach).**
v1's "segment the mesh into material regions" was its weakest idea — it needs semantic
understanding per asset. Replace with **per-face color quantization**, which needs none:
1. Sample each face's average color from the texture Meshy generated.
2. Snap it to the **nearest swatch/ramp in the master KayKit-style palette**.
3. Re-UV that face onto the corresponding region of the one master gradient atlas.
4. Delete the Meshy texture; apply the shared flat material.

Every asset ends up referencing the same atlas file. No segmentation, no human tagging, pure
Blender-headless script. Meshy's texture is used only as a *color oracle*, so its per-asset drift
stops mattering — drift gets quantized away.

---

## 3. Animation system (the other core revision)

v1 treated animation as "Meshy per-character clips." At library scale that gives every character an
island of baked animations. Instead:

- **Rig every character with the same auto-rig pipeline** (Meshy auto-rig; it costs 0 credits and
  outputs a consistent humanoid bone layout across characters). Tripo as fallback for odd
  body plans — its non-humanoid bone placement benchmarks well.
- **Maintain ONE shared animation library**, applied via **retargeting**, not per-character
  generation: Meshy's preset clips (500+) seed the library; engine-side retargeting (Godot
  humanoid retarget / Unity Humanoid / UE IK Retargeter) or a scripted Blender retarget pass plays
  any clip on any character.
- Result = KayKit's actual character value proposition: N characters × M animations for the cost
  of N rigs + M clips, instead of N×M baked combinations.
- Quadrupeds/monsters get their own skeleton class(es) with their own shared clip sets.

**Validation gate addition:** auto-rigged characters get an automated pose test (play 2–3 clips,
check for mesh collapse via vertex-deviation heuristics) plus contact-sheet review. Auto-rig weight
painting is the most common silent failure (shoulder/jaw weights are a known weak spot).

---

## 4. Pipeline (end to end)

```
[A] STYLE KERNEL (one-time)
     master gradient atlas + palette config; style-ref image set from KayKit renders
     (optional later: LoRA)
[B] CONCEPT        text prompt → 2D concept in house style (style-ref conditioned; T-pose for chars)
[C] GEOMETRY       Meshy Image-to-3D, low-poly mode, per-class poly budget
[D] NORMALIZE      Blender headless: scale/pivot/orientation to house standard; remesh if needed
[E] PALETTE SNAP   per-face quantize → re-UV onto master atlas → shared material   ◄ quality gate 1
[F] RIG            auto-rig to skeleton class (humanoid/quadruped); pose test      ◄ quality gate 2
[G] RETARGET       shared animation library applied per skeleton class
[H] VALIDATE+PACK  poly/material/UV checks, naming, GLB/FBX export, engine import test
[I] REVIEW         auto-generated HTML contact sheet (turntable renders); accept/reject per asset
```

Orchestrated by a manifest-driven Python runner against Meshy's async API (Pro+ required for API;
10 concurrent tasks on Pro), idempotent and resumable. Rejects loop back to [B] with a new seed.

**Honest scope note:** the *pipeline* is 100 % AI/script, but plan for a human accept/reject pass
at stage [I] — expect a 20–40 % generation reject rate. Reviewing a contact sheet is minutes per
hundred assets; skipping it means shipping the reject rate into the library.

---

## 5. Cost model (order of magnitude)

- Full generation ≈ **20 credits** (mesh + texture); **rigging and animation are 0 credits**.
- Pro $20/mo = 1,000 credits ≈ 50 full generations ≈ **~20–25 accepted assets** at 2–3 candidates
  per accepted slot.
- A "much larger than KayKit" library (say 1,000+ accepted assets) ≈ 2,000–3,000 generations ≈
  40–60k credits ≈ **very roughly $800–1,200** at Pro-tier credit pricing — i.e. Studio tier or
  API pay-as-you-go territory, spread over the project. Re-estimate after the Phase-0/1 spike
  measures the real reject rate; that's the dominant cost variable.
- Commercial rights require a paid tier (free-tier output is CC-BY, public, non-commercial-ish).

---

## 6. Licensing position

- **KayKit as style input** (references, palette, LoRA training data): CC0 — clean, including
  LoRA training.
- **Meshy output**: owned/commercial on paid tiers; verify terms at generation time.
- **Caveat worth knowing:** purely AI-generated assets may not be copyrightable (US doctrine),
  so the library itself may be hard to protect against copying. Curation, edits, and the pipeline
  itself are where ownership is defensible. This matters only if the plan is to *sell the asset
  library*; for use in a game it's mostly moot.

---

## 7. Phased plan (revised)

- **Phase 0 — Spike the two cruxes (1 prop + 1 character):** run one prop through B→E and one
  character through B→G with two shared clips retargeted. Eyeball both next to real KayKit assets.
  *Exit: the character animates convincingly with a shared clip AND matches the palette.* v1's
  prop-only spike validated the easy half.
- **Phase 1 — Scripted single-asset runs** of both paths, no manual steps.
- **Phase 2 — Batch 20 mixed assets;** measure reject rate, drift, cost; tune candidates-per-slot.
- **Phase 3 — Scale run** (hundreds), contact-sheet review flow, taxonomy/naming, pack export.
- **Phase 4 — Optional style hardening:** train the LoRA if Layer-1 style-ref drift is visible at
  volume; add skeleton classes (quadruped etc.).

---

## 8. Deliverables

- Master atlas + palette config (the "style kernel")
- Concept-stage prompt/style-ref templates (+ optional LoRA)
- Orchestrator (Python, Meshy API, manifest-driven, resumable)
- Blender headless scripts: normalize, palette-snap re-atlas, validate, retarget, render
  contact sheets
- Shared animation library per skeleton class
- README + cost/reject-rate report from Phase 2

---

## 9. Answers to v1's open questions (from this review)

1. **Re-atlas by segmentation?** Rejected — replaced with per-face color quantization against the
   master palette (needs no semantics, fully deterministic).
2. **Meshy retexture for consistency?** Correctly distrusted — v2 demotes Meshy textures to a
   color oracle whose drift is quantized away.
3. **Phase 0 scope?** Right instinct, wrong asset: must include a *character through retargeting*,
   since animated characters are the actual goal.
4. **Missing tools?** 2D style-ref/LoRA stage (biggest miss); Tripo as non-humanoid rig fallback;
   engine-native retargeting instead of hand-rolled animation transfer.
5. **Over/under-engineered?** Over: full orchestration before the spike. Under: no shared-skeleton
   plan, no reject-rate/cost model, no review-at-scale mechanism, no taxonomy — all added above.
