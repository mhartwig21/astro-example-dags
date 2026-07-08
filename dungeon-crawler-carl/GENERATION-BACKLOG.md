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
| Elite affix differentiation (7 of 9 affixes invisible; the audit's #1 readability hole) | Alternate texture PNGs shipped with most characters (`orc_texture_A/B`, …) for recolored elite skins, **plus** the existing emissive-tint mechanism (`weaponry.ts rarityGlow` pattern) for per-affix body glow — semantic colors per STYLEGUIDE (warded=arcane, armored=ember, chilling=lore-blue…) | texture swap in `buildMonsterMesh`; tint code-only |
| Flask / Sponsor Slurp™ drink act | Adventurers 2.0 **potion props** (67 held props in the pack); check untapped clip packs (medium **Simulation/Tools**) for a drink/use clip before generating one | graft prop on cast + clip |
| Filcher "it's carrying your gold" token | Resource Bits **money pile / gold bars** mini-prop grafted to the Hoarder (same pattern as the key-carrier octahedron, `renderer3d.ts:1836`) | graft in `buildMonsterMesh` |
| Blindside / phantom-blink poof anchor | Adventurers 2.0 **smokebomb prop**; the poof itself stays procedural (spawnGlow) | prop + FX code |
| Shaman heal / summoner birth caster tells | Art already exists — `cast_raise`/`Ranged_Magic_Raise` in the loaded rig libraries. The gap is **sim-side** (these casts have no windup, so no clip/ring fires) | small sim change, zero assets |
| More boss/mob flourishes (enrage roar, crawls, tool use) | **Untapped clip packs**: medium MovementAdvanced / Simulation / Tools; large MovementAdvanced / Simulation / Special — load into `RIG_CLIP_MANIFEST` and inventory the clip names before generating ANY monster clip | assets.ts manifest row |
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
| Stunt Double cast — a showman "presenting / beckon" gesture | Adventurers 1.0 (hero skins) | Audit: the cast plays NOTHING today | Library has an Acting category; 421 Over_Shoulder_Throw is a known fallback donor family |
| Flask drink | Adventurers 1.0 | Only if Simulation/Tools packs lack one | |
| Boss enrage roar / chest-beat | Rig_Large | Phase transitions have no body act | Check large Special pack first |
| Extradition alternate take | Adventurers 1.0 | Taste option vs shipped 239 | 421 Over_Shoulder_Throw or 398 Crouch_Charge_and_Throw; two-command re-bake |
| Filcher gloating scurry / loot-clutch run | Rig_Medium | Sells the theft while fleeing | Only after the gold-pile prop ships |

Rig-task note: Rig_Medium/Large donors need a rigging task each (5 credits,
reused for every clip on that rig); the Adventurers 1.0 rig task from the
Extradition job can be reused while it hasn't expired (task ids in
`tools/asset-pipeline/out/extradition/`).

## 3. Meshy model queue (text-to-3D + palette snap, ~20 credits each)

Things KayKit will never ship: **Dungeon Crawler Carl's game-show layer.** All
props, all static — no rigging. House-style prompt suffix + palette snap keep
them on-atlas by construction.

| Asset | Use | Prompt sketch |
|---|---|---|
| **Hovering broadcast camera drone** | The Show made visible: idles over the player during high-hype moments, orbits ringside intros | "low poly hovering camera drone with a single large lens, boxy sci-fi body, small rotors, stylized game asset, chunky proportions, flat colors" |
| **System loot box** | Loot-box moments currently have no prop; the novels' signature object | "low poly ornate mystery loot box with glowing seams and a question mark emblem, closed, stylized game asset, chunky proportions, flat colors" |
| **Sponsor ordnance shell** | Replaces the repurposed `keg.glb` airstrike prop (and BACKLOG #5's clown-bomb overreach) with real branded ordnance | "low poly cartoon aerial bomb with fins and a sponsor logo panel, stylized game asset, chunky proportions, flat colors" |
| **Gavel head chain anchor** | Extradition capstone is CLASS ACTION / Gavel Drop — a gavel-head weight on the chain's far end sells the legal-satire lane | "low poly wooden judge gavel head, oversized, stylized game asset, chunky proportions, flat colors" |
| **Jumbotron / hype screen** | Boss-arena set piece; The Show's presence in-world | "low poly stadium jumbotron screen on a riveted metal frame, slightly tilted, stylized game asset, chunky proportions, flat colors" |
| **Spotlight rig** | Ringside-intro moment dressing | "low poly stage spotlight on a metal truss mount, stylized game asset, chunky proportions, flat colors" |
| **Extraction stairwell portal frame** | Stairs-down currently reuses dungeon stairs; a System-branded descent gate reads as "next episode" | "low poly ornate archway portal frame with hazard stripes and small lights, stylized game asset, chunky proportions, flat colors" |
| **Achievement trophy set** (small/medium/large) | Cash-payout achievement moments; vault dressing variety | "low poly golden trophy cup on a stone base, stylized game asset, chunky proportions, flat colors" |

Batch note: run these as ONE manifest (`manifest.json`, resumable) — this
doubles as plan-v2 **Phase 2's** batch: measure the real reject rate and
cost per accepted asset while producing useful props.

## 4. Flagship: the full character path (plan-v2 Phase 0 exit)

One bespoke character through the ENTIRE pipeline: text-to-3D (T-pose prompt)
→ palette snap → Meshy auto-rig → shared-clip retarget onto its own skeleton →
in-game with the standard animation state machine. Candidate with no KayKit
answer: **a System announcer/host avatar** (the Show's on-floor presence — a
floating tuxedo'd AI mannequin fits the fiction and tolerates rig jank better
than a combat mob). This is the pipeline milestone, not a quick win; do it
after the prop batch proves reject rates.

## Keeping this honest

- Ship a row → delete it here; record provenance in ASSETS.md (`Meshy (<plan>)`
  for generated, pack row for KayKit).
- Prices/endpoints move: re-check credits and the animation library before
  each batch.
