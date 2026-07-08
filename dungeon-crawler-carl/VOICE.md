# Voice — who speaks, and where

Audit of every player-facing string in the game (2026-07-08: UI hosts, sim
layer, docs), and the rule that falls out of it. Owner direction: **lean into
the System inside the dungeon; keep the production voice for between-floor /
meta surfaces** — matching the books, where the showrunners live outside the
dungeon and the in-dungeon voice is the System's deadpan game-admin snark.

## The audit in one paragraph

The game already speaks two coherent registers — they're just not assigned by
surface. **The System register is our best writing and already dominates
where it's consistent**: all 12 achievements are pure bureaucratic deadpan
(LIQUIDITY EVENT, CONSCIENTIOUS OBJECTOR), the shrine talks in contract
language ("The System respects cowardice; it just doesn't pay for it"), boss
names run landlord/HOA civic satire (The Rent Collector, The HOA President),
and the strongest full sentences in the UI are ToS snark ("the System is
legally required to inform you that survival is optional"). **The production
register concentrates in two places**: (a) ~35 in-run announcement lines that
fuse both voices in one sentence ("The exit is SEALED. Ratings, Crawlers."),
and (b) the fun-kit ability trees (Cut To / Crowd Surf / Stunt Double — 13 of
55 upgrade nodes; the other 42 nodes across the 8 core abilities are fully
neutral). The meta surfaces (menu, recap, seasons/career) already lean
production — which is where it should live. Neutral mechanical text outnumbers
both voices ~2:1 and stays neutral.

Net: this is NOT a mass rename. It's one band of announcer-line rewrites plus
a written rule.

## The rule: one institution, two registers

There is one talking entity — **the System** — which *runs* a broadcast
called **the Show**. The register it uses depends on where you're standing:

### Inside the run → SYSTEM register
Deadpan bureaucratic game-admin. Patch notes, liability waivers, audits,
fine print, refunds not offered.

**Owner correction (2026-07-08): the System is show-AWARE, not show-blind.**
In the books the System calls everyone "Crawler(s)" constantly and mentions
ratings, the audience, and the cameras when it suits it — it hosts the show.
So the tell for this register is **enthusiasm, not vocabulary**: the System
mentions ratings the way an accountant mentions a deadline; a production
announcer celebrates them. "The exit is SEALED. Ratings, Crawlers." passes —
terse, bored, ratings-as-justification. A line only fails when the narrator
sounds like a hype-man: breathless, cheering, selling.

> "Viewership in your sector has declined 34%. Corrective content has been
> scheduled."

Owns: `state.announcements` (all in-run banner/ticker text), achievements,
shrines, level-up drafts, floor-entry lines, rules events (lost key, door
audits), death lines, collapse warnings.

Reference exemplars (already shipped, this is the target tone):
- "The floor key is GONE. The System audits the ledger and WAIVES the door fee."
- "…let the ritual finish. The System does not offer refunds."
- "…AUTHORIZED AN AIRSTRIKE. Clear the drop zone. Or don't — ratings."
- "CONNECTION LOST. The System apologizes for the technical difficulties."
- Every achievement name in `achievements.ts`.

### Between floors / meta → PRODUCTION register
Showbiz. Seasons, ratings, contracts, the cameras. This is where the Show
gets to be television, because the crawler is briefly off the arena floor.

Owns: home menu (RINGSIDE CHECK-IN), run recap (SEASON RATINGS, SEASON
FINALE, "season two is contractually obligated"), career/RECENT SEASONS,
sponsor draft (fires on descent — between floors), safe room (the manager's
tips are a distinct character voice; keep), leaderboard framing.

The menu kicker "◆ THE SYSTEM PRESENTS ◆" stays — the fusion IS the premise:
the System presents the Show.

### Always, everywhere → the two carve-outs

1. **Objects can be show-branded; narrators can't.** Sponsor merch inside the
   dungeon is diegetic — Prime-Time Cleaver, Showstopper Plate, Sponsor
   Slurp™, Plot Armor all stay. What changes is the *announcer* hyping them.
   The System reads a sponsor product's name the way a bored customs officer
   reads a manifest.
2. **The crowd is diegetic too.** "The crowd is CHANTING {NAME}" is the
   System reporting an observable fact, not producer-speak. Frenzy lines
   stay. The show telemetry chips (viewers/favorites/sponsors counters) are
   data, not voice — untouched.

### Sanctioned sub-flavors
- **Civic satire** (Knuckles the Landlord, The Crypt Concierge, The HOA
  President) is the System's bureaucratic universe leaking into monster
  naming. It's SYSTEM-lane. Keep and extend.
- **Ringside introductions**: boss intros are the one place the books' System
  goes theatrical — the game-show host AI loves announcing carnage. The
  RINGSIDE INTRODUCTION freeze stays as the System's sanctioned showman
  moment. (Owner may overrule; flagged as the one deliberate exception.)

## Ability names: System register by default (renamed 2026-07-08)

Owner direction: rename production-voiced abilities wherever a System-register
name is as good or better; keep the ones too apt to lose. The executed slate:

| Was | Now |
|---|---|
| Cut To | **Blindside** (Long Reach / Short Notice / Sucker Punch / REPEAT OFFENDER) |
| Crowd Surf | **Extradition** (Long Arm / Contempt / Gavel Drop / CLASS ACTION) |
| Bullet Time's ENCORE capstone | **EXTENSION** ("Extensions are granted automatically.") |

Kept: **Stunt Double** and its whole tree (the name IS the mechanic),
**Sponsor Airstrike** + SPONSOR LOYALTY (mechanically sponsor-entangled —
carve-out #1 earned, not borrowed), **Bullet Time** itself (established
gaming term, tagged neutral).

The rule going forward: new abilities and nodes get neutral or System-register
names (the legal/civic-satire lane — Extradition, CLASS ACTION, REPEAT
OFFENDER — is the sanctioned flavor) unless the ability is *mechanically*
entangled with the show economy (a Crowd Work that literally spends hype has
earned a showbiz name; a teleport hasn't). The pending ABILITY-CONCEPTS.md
slate should be re-titled through this filter when implemented — e.g.
milestone class offers are a System menu event ("CLASS REVISION AVAILABLE"),
not a CASTING CALL.

## The worklist

### 1. ~~Rewrite the blended in-run announcement lines~~ — RETIRED (2026-07-08)
The original audit flagged ~35 "blended" lines for rewrite. The owner
correction above dissolves this: "Crawlers" as address and deadpan ratings
mentions ARE the System's canon register, so the shipped lines pass. The
enduring rule for NEW announcement lines: write them show-aware but bored —
if a line reads breathless or cheering, cool it down. No retro-rewrite pass.

### 2. Catalog desc pass (names stay)
Item *names* are fine under the merch carve-out. Sweep `catalog.ts`
descriptions so every one lands System-register (most already do: "Warranty
void.", "Auto-renews. Cancellation is difficult."). Rewrite the handful of
pure-hype descs ("Ratings never sleep.") only if they read as narrator rather
than ad copy — ad copy on a sponsor product is diegetic and may stay.

### 3. Doc touch-ups (low priority — the existing docs are mostly right)
- `DESIGN.md` §5.5–5.6 and `CLAUDE.md`'s "game-show announcer voice" line
  turned out to be accurate as written (the System IS the announcer, show-
  aware and deadpan); optionally link them here.
- `STYLEGUIDE.md`: the "stone is for SETS, glass is for the fight" rule
  already draws the surface boundary visually — optionally add: **stone may
  go full showbiz (SEASON RATINGS, RINGSIDE CHECK-IN); glass stays terse
  and bored.**

### What does NOT change
Show economy mechanics and data (hype/viewers/favorites/sponsors), the show
bar, the in-run announcement corpus (see retired item #1), ability names and
constellation node names, achievement names, monster/boss names, item names,
the safe-room manager, the menu/recap production voice, RINGSIDE
INTRODUCTION, "THE SYSTEM PRESENTS".

Delete sections from this doc as they ship (BACKLOG.md convention).
