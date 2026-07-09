# Asset generation backlog — KayKit first, then Meshy

The rule: **the collection is already paid for and pre-styled — mine it before
spending a credit.** Meshy (via `tools/asset-pipeline/`) fills only what KayKit
can't provide. Costs at current API pricing: a retargeted animation clip ≈ 8
credits (rig 5 + clip 3, rig reused across clips), a palette-snapped prop ≈ 20
credits, a full playable character (generate → snap → rig → clip set) is the
expensive flagship path (plan-v2 Phase 0 exit).

Source-of-truth cross-refs: KAYKIT-INVENTORY.md (what we own),
`tools/asset-pipeline/README.md` (how to generate), ASSETS.md (record
everything that ships). Gaps below trace to the 2026-07-08 ability-presentation
audit. Delete rows as they ship.

## 1. Perfect-fit KayKit assets (no generation needed)

| Gap / need | KayKit answer | Seam |
|---|---|---|
| ~~Elite affix emissive tints~~ **SHIPPED 2026-07-08** (semantic body glow + chilling aura ring); alternate-texture recolor skins still open as a richer second pass | Alternate texture PNGs shipped with most characters (`orc_texture_A/B`, …) | texture swap in `buildMonsterMesh` |
| Flask / Sponsor Slurp™ drink act | Adventurers 2.0 **potion prop staged** (`potion_medium_red.glb` in the manifest); no drink clip exists in ANY clip pack (inventoried 2026-07-08) → the clip moved to the Meshy queue | graft prop on cast + generated clip |
| ~~Filcher gold token~~ **SHIPPED 2026-07-08** (money-pile graft, visible while `carry > 0`) + Sneaking clip while unnoticed | — | — |
| Blindside poof anchor (player half; ~~phantom blink~~ **SHIPPED 2026-07-08** with procedural poofs + mesh snap) | Adventurers 2.0 **smokebomb prop staged** (`smokebomb.glb`); the poof stays procedural | FX code |
| ~~Shaman heal / summoner + broodmother caster tells~~ **SHIPPED 2026-07-08** (windup channels "heal"/"summon" → cast_raise clip + telegraph ring; interruptible by killing the caster) | — | — |
| ~~Clip packs~~ **LOADED 2026-07-08** (all 14); ~~boss enrage act~~ **SHIPPED** via EXPERIMENTAL_Large_Transform on the phase edge | — | — |
| APPROACH mob cast (MOB-CONCEPTS roster; IRONWORKS robots shipped 2026-07-08) | Still-unused characters: Ninja, Marksman, AvianSwordsman, MagicalGirl, 4GTN golems, Monstrosity (custom rig — verify), CombatMech, Tiefling, Cleric, Paladin… | CHARACTER_RIGS + manifest |
| Floor traps (if they ship) | Platformer Pack: saws, spikes, swipers, hammers, conveyors (525 models) | future |
| Show set dressing / safe rooms / crafting | Board Game Bits (cards/dice), RPG Tools (anvil, lockpicks), Furniture + Restaurant Bits | future |

Purely procedural (no asset exists or needed — code work from the audit):
charger **lane** telegraph (reuse beam plane-strip), Bullet Time screen tint +
audio low-pass, boss phase-enrage tint/aura, Cataclysm ring-radius bug + echo
keg mis-render, player-body status FX.

## 2. Meshy clip queue (rig once, ~3 credits per clip after)

Generated on a rigged donor via `orchestrator/animate.py`, retargeted onto the
house rig with `blender/retarget_clip.py --rest-source <rig-task T-pose GLB>`.
Precedent: the Extradition cast (action 239 → Adventurers 1.0 rig, shipped
2026-07-08). **Browse docs.meshy.ai/en/api/animation-library for ids before
each batch** — and check the untapped KayKit clip packs first (row above).

| Clip | Target rig | Why | Notes |
|---|---|---|---|
| ~~Stunt Double cast~~ **SHIPPED 2026-07-09** (preset 42 Gentlemans_Bow — the professional takes the stage) | — | — | — |
| ~~Flask drink~~ **SHIPPED 2026-07-09** (preset 342 Stand_and_Drink + the potion prop in the off hand, weapon stowed) | — | — | — |
| Extradition alternate take | Adventurers 1.0 | Taste option vs shipped 239 | 421 Over_Shoulder_Throw or 398 Crouch_Charge_and_Throw; two-command re-bake |
| Filcher gloating scurry / loot-clutch run | Rig_Medium | Sells the theft while fleeing | Only after the gold-pile prop ships |

Rig-task note: Rig_Medium/Large donors need a rigging task each (5 credits,
reused for every clip on that rig); the Adventurers 1.0 rig task from the
Extradition job can be reused while it hasn't expired (task ids in
`tools/asset-pipeline/out/extradition/`).

## 3. Meshy model queue (text-to-3D + palette snap, ~20 credits each)

Things KayKit will never ship — but **diegetic dungeon objects only**. The
Show is a META layer (announcer, HUD, tickers — the "Torchlit Broadcast"
chrome); the world itself is a dungeon run by the System AI. Objects the
System *provides* (loot boxes, sponsor-branded ordnance, branded gates) are
fine; studio hardware (camera drones, jumbotrons, spotlights) is not —
rejected 2026-07-09, owner ruling.

| Asset | Use | Prompt sketch |
|---|---|---|
| ~~System loot box~~ **SHIPPED 2026-07-09** | dropped at the crawler's feet on the grant edge | — |
| ~~Sponsor ordnance shell~~ **SHIPPED 2026-07-09** | airstrike strikes fly as real ordnance; keg retired | — |
| ~~Gavel head chain anchor~~ **SHIPPED 2026-07-09** | rides the Extradition chain's far end, fading with the links | — |
| **Extraction stairwell portal frame** | Stairs-down currently reuses dungeon stairs; a System-branded descent gate reads as "next episode" | "low poly ornate archway portal frame with hazard stripes and small lights, stylized game asset, chunky proportions, flat colors" |
| **Achievement trophy set** (small/medium/large) | Vault dressing variety (diegetic: the System mints them) | "low poly golden trophy cup on a stone base, stylized game asset, chunky proportions, flat colors" |

Batch note: run these as ONE manifest (`manifest.json`, resumable) — this
doubles as plan-v2 **Phase 2's** batch: measure the real reject rate and
cost per accepted asset while producing useful props.

## 3b. Spell-FX mesh kit (the "Diablo layer")

A Diablo-style ability effect is three layers: an authored effect MESH, motion
curves, and material tricks (additive/emissive). Meshy supplies only the mesh —
motion stays in the renderer's existing juice code (the nova ring already
scales/fades; it just scales a bare torus), and materials get an
emissive/additive treatment at load rather than the prop pipeline's plain
atlas material. KayKit ships zero VFX meshes (sole exception: the DemonLord
SummoningCircle — reuse/retint it for raise/summon channels before generating
a magic circle).

**Test SHIPPED 2026-07-09**: Nova ring + Cataclysm crown generated, emissive
treatment in `renderer3d.buildFxRing`, verified in-app. Findings: fine surface
detail (runes) does NOT survive generation — prompt for chunky silhouettes,
not engravings; dark albedo + strong emissive reads as saturated glow (a
feature); the palette snap is fine for effect meshes since the tint comes
from the emissive layer. Cataclysm also got its correct radius and the
Aftermath echo stopped rendering as an airstrike keg (crown ground marker).

| Effect mesh | Replaces | Prompt sketch |
|---|---|---|
| ~~Nova rune shockwave ring~~ **SHIPPED** | the bare blue torus | — |
| ~~Cataclysm eruption crown~~ **SHIPPED** | Nova's reused torus | — |
| ~~Implosion swirl cone~~ **SHIPPED 2026-07-09** | collapsing vortex on the nova.implode cast | — |
| ~~Flame wall~~ **SHIPPED 2026-07-09** | flame clusters per Flame Sweep cell (`Hazard.flavor: "flame"`); kills BACKLOG #5's clown-bomb overreach for this signature | — |
| ~~Detonation star~~ **SHIPPED 2026-07-09** | zero-amount crit flashes (Gavel Drop, EXTINCTION pops, Stunt Double exit) burst a spiked star | — |
| ~~Airstrike blast star~~ **SHIPPED 2026-07-09** | debris ring under each keg impact | — |

Not a mesh job: Bullet Time (screen-space), status auras (procedural rings
already read well).

## 4. Flagship: the full character path (plan-v2 Phase 0 exit)

One bespoke character through the ENTIRE pipeline: text-to-3D (T-pose prompt)
→ palette snap → Meshy auto-rig → shared-clip retarget onto its own skeleton →
in-game with the standard animation state machine. Candidate with no KayKit
answer: **a sponsor mascot** ("The Brand Ambassador" — a big plush-costume
humanoid enforcer; boss/elite material, on-tone for the Show, forgiving of
first-attempt rig jank). The System itself stays disembodied by design (it's
an AI — the camera drone above is its embodiment). Alternatives: a "former
favorite" rival crawler, or an APPROACH band boss. This is the pipeline
milestone, not a quick win; do it after the prop batch proves reject rates.

## Keeping this honest

- Ship a row → delete it here; record provenance in ASSETS.md (`Meshy (<plan>)`
  for generated, pack row for KayKit).
- Prices/endpoints move: re-check credits and the animation library before
  each batch.
