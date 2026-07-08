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
fine print, refunds not offered. The System reports even show metrics as
bureaucracy — engagement numbers, not applause:

> "Viewership in your sector has declined 34%. Corrective content has been
> scheduled."

Owns: `state.announcements` (all in-run banner/ticker text), achievements,
shrines, level-up drafts, floor-entry lines, rules events (lost key, door
audits), death lines, collapse warnings.

Reference exemplars (already shipped, this is the target tone):
- "The floor key is GONE. The System audits the ledger and WAIVES the door fee."
- "…let the ritual finish. The System does not offer refunds."
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

## Ability names: grandfather, then default System

The shipped fun-kit names (Cut To, Crowd Surf, Stunt Double) and their
production-voiced nodes (MATCH CUT, STAGE DIVE, AWARD SEASON, ENCORE,
SPONSOR LOYALTY) are **grandfathered under carve-out #1**: they read as the
Show's branding of your signature moves, which is plausible in-universe and
they're good names. No renames.

Going forward the default flips: new abilities and nodes get neutral or
System-register names unless the ability is *mechanically* entangled with the
show economy (a Crowd Work that literally spends hype has earned a showbiz
name; a teleport hasn't). The pending ABILITY-CONCEPTS.md slate should be
re-titled through this filter when implemented — e.g. milestone class offers
are a System menu event ("CLASS REVISION AVAILABLE"), not a CASTING CALL.

## The worklist

### 1. Rewrite the blended in-run announcement lines (~35 in game.ts + ai.ts)
The pattern to kill: System sentence + showbiz tag welded on. Representative
rewrites (current → proposed):

| Current (verbatim) | Proposed |
|---|---|
| "CITY BOSS: {name} holds floor {n}. The exit is SEALED. Ratings, Crawlers." | "CITY BOSS: {name} holds floor {n}. The exit is SEALED. This is a compliance mechanism." |
| "Descending to floor {n}. The cameras are rolling, Crawlers." | "Descending to floor {n}. The System has prepared it. It is not sorry." |
| "{name} drops into the dungeon. The audience loves fresh meat." | "{name} has entered the dungeon. Liability waiver: accepted by default." |
| "{p}'s sponsors have AUTHORIZED AN AIRSTRIKE. Clear the drop zone. Or don't — ratings." | "SPONSOR ACTION: airstrike authorized. The System recommends not standing in the delivery area." |
| "PARTY WIPE. The season finale nobody wanted. The crowd goes wild." | "PARTY WIPE. Survival was optional. All crawlers have opted out." |
| "The boss is DESPERATE. Everything is a projectile. RATINGS." (ai.ts) | "The boss is DESPERATE. Everything is a projectile. The System disclaims all of it." |
| "…CRACKS THE FLOOR. Everything airborne is a highlight." | "…CRACKS THE FLOOR. Airborne objects are now your problem." |

Method: grep `announce(` in `src/sim/game.ts` and `src/sim/ai.ts`, rewrite
every line whose voice is production or blended into pure System register.
Show-*subject* lines (sponsor gifts, frenzy, viewer milestones) keep their
subject but switch narrator: metrics administered, not celebrated. Boss
signature telegraphs ("THE SLUICES OPEN…") lean System-deadpan while keeping
the mechanical instruction intact — the telegraph text is UX, don't bury it.

### 2. Tag voice on the announce rail (small code change)
`announce()` already takes a `kind`. Add `voice: "system" | "show"` (default
"system") so hosts can style the rare Show-voiced line differently later
(e.g. the recap feed). Cheap now, enables per-voice styling forever.

### 3. Catalog desc pass (names stay)
Item *names* are fine under the merch carve-out. Sweep `catalog.ts`
descriptions so every one lands System-register (most already do: "Warranty
void.", "Auto-renews. Cancellation is difficult."). Rewrite the handful of
pure-hype descs ("Ratings never sleep.") only if they read as narrator rather
than ad copy — ad copy on a sponsor product is diegetic and may stay.

### 4. Docs to update when #1 ships
- `DESIGN.md` §5.5–5.6: name the two-register rule (currently asserts a
  single "System announcer" with no register split).
- `CLAUDE.md` tone line: "the System's game-show announcer voice" → the
  two-register formulation.
- `STYLEGUIDE.md`: the "stone is for SETS, glass is for the fight" rule
  already draws this exact boundary visually — add the voice sentence to it:
  **stone speaks Show, glass speaks System.**

### What does NOT change
Show economy mechanics and data (hype/viewers/favorites/sponsors), the show
bar, ability names and constellation node names, achievement names, monster/
boss names, item names, the safe-room manager, the menu/recap production
voice, RINGSIDE INTRODUCTION, "THE SYSTEM PRESENTS".

Delete sections from this doc as they ship (BACKLOG.md convention).
