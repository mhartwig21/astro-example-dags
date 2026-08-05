# HANDOFF — where the game stands, and what to pick up

Written at `main@48d5f03`, deployed to production. Replaces the previous
handoff (which described the long-since-merged `aaa-perfection` integration).

**Read `CLAUDE.md` first** — this file assumes it. This one covers only what a
new session cannot reconstruct from the code and git history: open threads,
verdicts still owed, and the specific ways this project has been got wrong
before.

---

## 0. THE ONE LESSON THIS PROJECT KEEPS RE-LEARNING

**Measuring the wrong thing and reporting it as success.** Every serious defect
found this session came from an instrument that was green about something
adjacent to the question. All of these shipped:

| what was measured | what mattered | how it surfaced |
|---|---|---|
| "is the crawler inside the viewport" (`\|ndc\| > 1`) | is the crawler *findable* | owner: "really hard to see your own player" — the probe reported 0 failures |
| LUFS, seams, duck depth (audio audit scored 8.8/10) | is the ability roster audible at all | 13 of 16 abilities cast in silence; the audit enumerated the director's mappings, not the roster |
| decoded-clip loudness | resident memory | 639.6 MB of PCM held for the session, never once weighed |
| floor-1 tutorial card pacing | floors 2-18 | the curriculum rule was scoped to `state.floor === 1`; every deeper floor got the full 16-tip flood |
| "the shop renders tier sections" | do the sections *read* as sections | ~28 filler "well" tiles made five bands look like one grid |

The shape is always the same: **the instrument was accurate and the question
was wrong.** Before writing a probe, write down the sentence the owner would
say if the feature were broken, then check that the probe would fail on it.

Corollary: **the owner's ear and eye are the only acceptance for anything
subjective.** No agent in this loop can hear audio. Spectrograms, CLAP scores
and LUFS tables catch *incoherence*; they cannot catch *bad*. Always say which
of the two you measured.

---

## 1. WHAT IS LIVE (main@48d5f03)

Deployed and verified: `/health` fresh, `/iso.html` 200, exactly one machine.

- **Audio r2** — music streams (639.6 MB → 15.5 MB resident PCM; renderer
  working set 934 → 285 MB). All 16 abilities have a cast cue. `dash` and
  `level_up` regenerated; footsteps **deleted by owner order**.
- **Polish r1** — shop rarity sections restored, verdict grade removed, menu
  CTA 1.62x → 1.26x, ability screen opens on LIST.
- **Boss camera r2** — owner-verified live.
- **Courtesy explanations** stop flowing past floor 1.
- **Tutorial r5** — Mordecai's first-run onboarding.
- **Mobile** — Wild Rift geometry, iOS multi-touch fix, LOCK chip removed.

`rulesEra` moved `564d5ba → 98b1470` in this release (tutorial sim tips). Prior
run proofs are retired — that is the system working, not a bug.

---

## 2. OPEN — OWNER VERDICTS OWED

Blocked on the owner, not on work. Do not "resolve" these by measuring harder.

1. **The new `dash` and `level_up` sounds are unjudged.** Both stay OPEN in
   `SOUNDPLAN.md §1.3a` until cleared BY EAR. The audition sheet is built by
   `tools/audio/mk-audition.mjs` (23 clips, self-contained, ~5 MB — the page is
   gitignored, the generator is committed). Regenerate and send it.
2. **The 13 new cast cues** have never been heard by anyone. Same sheet.

`SOUNDPLAN.md §1.3a` is the standing register of owner verdicts on shipped
sounds. **Read it before touching audio.** Verdicts stay open until a
replacement is cleared, so "the owner already said this sucks" cannot get lost
between sessions again.

---

## 3. OPEN — WORK WITH A CLEAR NEXT STEP

### 3a. The tutorial rebuild (the biggest open thread)

Owner's direction, verbatim: *"the system courtesy explanations should entirely
be replaced by Mordecai's guidance -- I think sometimes its useful to have
guided tutorials as well where the player goes and does x, y, z before that
tutorial step ends so they know what they're doing. Mordecai is some times
talking in riddles."*

**PLUMBING SHIPPED on branch `tutorial-mordecai`** (TUTORIAL.md "r6" section
has the map): `src/ui/coach.ts` (Mordecai's strip, instruction-first beats,
onramp mechanics carried over; `src/ui/onramp.ts` deleted), `src/ui/objectives.ts`
(+ the `#objectives` card — four guided steps, checked by state observation,
`obj.*` on the tips ledger, fresh-crawler enrollment / veteran grandfathering),
tip translation in `showAnnouncement` (no tip ever prints in the System's
register), and the inverted binding rule enforced in `test/coach.test.ts`.
**CONTENT PASS shipped** (second commit on the branch — TUTORIAL.md's r6
section has the details): five objective steps (THE SHOW added as the
closer), THE FIVE key by key via live `{token}` labels, `elite`/`boss` depth
confirmations for floor-2+ pacing, and the S2 facts moved to sim-truth (the
old dash fact read a bot-only intent flag — a human could never check it).
STILL OWED: the `tools/_tut_r6.mjs` cold-profile acceptance battery (the
r1–r5 batteries assert COURTESY-era behavior and lie now; `_tut_r6_smoke.mjs`
and `_tut_content_probe.mjs` cover boot/paint/label-substitution only), a
full played-through browser round, and the owner's phone pass on the compact
objectives chip. The design that got us here:

- **One voice.** COURTESY EXPLANATION dies as a teaching format. The System
  keeps its announcer register for *events* (ringside intros, achievements,
  hype) — that is the game's tone and it is not teaching.
- **Mordecai gets a live channel.** Today he speaks only at rest by design (see
  the `src/ui/guide.ts` header). That rule must go if he is the teacher — he
  needs a lightweight in-play strip, not the modal `#dialogue` panel that
  pauses the world.
- **Objectives.** A small persistent card: a titled step with 2-3 checkable
  items, staying until all are done. Play never pauses.
- **The riddle fix is structural, not stylistic.** `guide.ts` currently FORBIDS
  Mordecai from teaching mechanics (there is a two-voice test in
  `test/guide.test.ts` enforcing it), which is exactly why every line he has is
  atmosphere: *"Sit down. Breathe. It counts as work."* Invert the binding
  rule — a teaching beat's FIRST sentence must contain the instruction and the
  key; wry gets sentence two. Testable the same way the current rule is.

### 3b. Shop — one unverified fix

`SHELF_ROW_BUDGET 7 → 6` (`main3d.ts`) and the gutter type cap (`iso.html`)
landed AFTER the browser pass that verified the rest of polish r1. Drive
`IN STOCK` at 1366x768 and confirm SIGNATURE is fully visible — it was 1%
visible before the fix, and the boundary case is the tab the shop opens on.

### 3c. Audio — loop ladder rungs 2 and 3

Music streams with native `el.loop` (rung 1) only. If a bed audibly gaps at the
wrap: `src/audio/deck.ts` already carries the spare deck rung 2 needs
(ping-pong crossfade); rung 3 is `stream: false` per id in the manifest, which
sends that one bed back to sample-accurate buffered looping. The seam
instrument is `engine.debugHook.musicSeam()` — **it returns null when the
worklet will not install, and null must be read as UNPROVEN, not as a pass.**

### 3d. `battle_winter.ogg` is 262 seconds

Four and a half minutes of music for a bed the director drops after a 6s battle
linger; 3.7 MB fetched mid-fight is a real phone stall. Trim through
`tools/audio/fix-beds.mjs` with a measured seam. Optional now that streaming
landed — it is a wire-cost fix, not a memory one.

---

## 4. THE INSTRUMENTS (use these before writing new ones)

| tool | what it answers |
|---|---|
| `tools/_bugcam.mjs` | boss camera: crawler's distance from centre, p50/p95/worst, fails outside the ±0.55 box. **Rewritten** — the old version only checked `\|ndc\| > 1` |
| `tools/audio/contactsheet.mjs` | spectrograms + waveforms + descriptors + pairwise distinctness matrix. Catches "13 renders came out as one whoosh" |
| `tools/audio/clapjudge.py` | CLAP audio↔text judge. **CALIBRATED — read the docstring**: `house` (audio↔audio outlier detection) works; `brief` (audio↔text) scored 3/6 on knowns and may never fail a clip alone. Venv at `~/.clap-venv` (py3.12 + CPU torch) |
| `tools/audio/measure.mjs` | per-file peak / LUFS / silence share / loop-seam delta |
| `tools/audio/probe-beds.mjs` | live music routing. Port overridable via `DCC_PORT` |
| `tools/audio/verify-r2*.mjs` | memory A/B, boot payload, the 16-cast roster drive |
| `tools/_mobile/battery_focus.mjs`, `ios_gesture_probe.mjs` | mobile merge gates |
| `tools/filmstrip.mjs`, `tools/feelprobe.mjs` | see `HARNESS.md` |

**Memory-measurement gotcha, learned the hard way**:
`performance.memory.usedJSHeapSize` does NOT move when AudioBuffers are freed —
they live outside the JS heap. Use `residentPcmBytes()` (walks live buffers) or
the process working set. And when matching processes: headless Playwright ships
`chrome-headless-shell.exe`, so a matcher on `chrome.exe` finds the *user's own
browser* and reports its churn as yours. That produced a bogus number once.

---

## 5. DEV BOX CONSTRAINTS (owner-stated, non-negotiable)

- **Never more than ~3 headless browsers at once.** Six crashed the machine.
  Three parallel workflows is fine; the browsers are the ceiling.
- **Never scale production past exactly one machine** (party state is
  in-memory — `DEPLOY.md`).
- **The owner tests on their phone against PRODUCTION.** A mobile-only
  judgment cannot be gated behind a localhost screenshot.
- Dev servers from other worktrees squat ports 5280-5290. **Check a port is
  free AND fingerprint what it serves** before trusting a probe — a whole round
  was once measured against a stale server on 5280 running another branch.
- PowerShell here-strings mangle commit messages: write the message to a file
  and use `git commit -F`.

---

## 6. STALE BRANCHES — do not blind-merge

Seven PRs are open from earlier sessions, all `mergeable: UNKNOWN` (old enough
that GitHub has not resolved them against current main): #161, #150, #147,
#134, #123, #12, #2. **#161 and #150 move sim numbers**, which rotates
`RULES_HASH` and retires every recorded run proof. None has been verified
recently. Rebase and test individually, or leave them.

Live worktrees: `focus`, `polish`, `audio2`, `main-preview` (branch
`preview-all` — the integration branch this release shipped from), `tut-fix`
(abandoned; the toast-hold work it holds was mooted by the tutorial redirect).
`node_modules` in the newer worktrees are junctions to `focus`'s.
