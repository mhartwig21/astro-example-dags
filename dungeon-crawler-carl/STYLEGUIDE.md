# The Torchlit Broadcast — UI design system

The canonical reference for every menu, panel, and HUD element. Visual pitch
with before/after mockups: https://claude.ai/code/artifact/edd98019-f019-4e6e-bff8-e24b6d558825
(source of truth for VALUES is this file). Inspirations: Diablo IV (stone +
ornamental gold), League of Legends (framed shop, item grid clarity), Path of
Exile 2 (engraved ledgers, small-caps serif). Anchored to KayKit's warm
low-poly dungeon and the DCC fiction: the dungeon is medieval, the Show that
broadcasts it is money. Every screen is a SET dressed by the System's
production crew — never a developer tool.

## The audit (what read as "AI-designed", 2026-07-05)

1. **One font, and it's a terminal** — everything set in `ui-monospace`.
2. **Blue-black surfaces** — `#0f0e18` navy panels against a warm ochre world.
3. **Neon cyan chrome** — `#4fd1ff` on buttons/XP/selection; the signature
   "AI slop" accent.
4. **Emoji as iconography** — ~99 glyphs (⚔ ◈ 🏁 ☠ 🛒 ▶ ★ ◆ ●) doing real UI work.
5. **40+ unmanaged hex values** — every subsystem grabbed its own hue.

Keeper: the gold pair `#c9a24b/#f2c14e` was already the game's most-used
color. It stays; the system is built around it.

## Tokens (CSS custom properties on `:root` in iso.html)

Surfaces (warm stone — never blue):
- `--void: #0e0b09` page/backdrop · `--stone: #171310` panel
- `--raised: #221b15` tiles/rows · `--hover: #2c241b` interaction

Frame + chrome:
- `--bronze: #6e5533` every border · `--bronze-hi: #a8854f` focus/hover edge
- `--gold: #c9a24b` (kept) the Show, prices, headers, primary buttons
- `--gold-hi: #f2c14e` (kept) headline emphasis

Ink:
- `--ink: #e8ddc8` parchment text · `--ink-dim: #a99f8c` secondary
- `--ink-faint: #6f6757` hints/disabled

Semantic (desaturated one step from today; ONLY on meaning):
- `--blood: #c0392f` HP/danger (was #e2574c)
- `--verdant: #6da356` heals (was #5fd08a)
- `--ember: #d98e4a` physical school (was #ff9a5c)
- `--arcane: #9a6bd0` magic school + epic (was #b998ff)
- `--lore: #5a87c6` XP, frost, magic tier (REPLACES all #4fd1ff cyan)

Rarity (D4/LoL convention — rare is GOLD):
- common `#b9b2a4` · magic `#5a87c6` · rare `#c9a24b` · epic `#9a6bd0`

## Typography

- **Display: Cinzel** (SIL OFL — bundle to `public/fonts/`, ASSETS.md row).
  Small-caps, `letter-spacing: 0.12em`. Titles, section bars, tabs, buttons,
  stat labels.
- **Body: Alegreya Sans** (SIL OFL — bundle). Descriptions, flavor, System
  chatter, tooltips. 12–15px.
- **Data:** body face + `font-variant-numeric: tabular-nums` wherever digits
  column up. Monospace survives ONLY in the debug console.

## The fourth rule (play feedback, 2026-07-05)

**Stone is for SETS, glass is for the fight.** The warm slab treatment
belongs to full-screen sets you step INTO (menu, shop, profile, recap,
keybinds). Anything overlaid on live gameplay — HUD chips, show bar, party
chip, ticker, announcements, and the level-up/sponsor offer plates — stays
quiet neutral glass (`rgba(0,0,0,0.5)` / the cool `rgba(12,10,20,·)` family)
so the dungeon reads through it. Fonts, icons, and accents still follow the
system; only the PLATE stays cool.

## The three rules

1. **Gold is the only chrome.** Frames bronze; emphasis/prices/headers/primary
   actions gold. No other hue may decorate structure.
2. **Semantic color on semantic things.** Blood only on HP/threat, arcane only
   on magic, lore-blue only on XP/frost. Not information → bronze or ink.
3. **Icons are drawn, never typed.** Every emoji becomes a game-icons.net SVG
   mask (pipeline + credits exist). Emoji count target: zero.

## Component recipes

- **Panel ("slab")**: `--stone` with a `--raised` top gradient; 1px `--bronze`
  border + `inset 0 0 0 1px rgba(0,0,0,.55)` double frame; 3px radius (not
  rounded-lg); small 45°-rotated bronze diamonds as top/bottom center caps.
- **Section header**: centered Cinzel small-caps gold with engraved side rules
  (1px bronze over 1px black) — the PoE "CHARACTER" bar.
- **Divider**: `border-top: 1px solid rgba(110,85,51,.7); border-bottom: 1px
  solid rgba(0,0,0,.55)`.
- **Primary button**: gold bevel `linear-gradient(180deg, --gold-hi, --gold
  45%, #8a6d3b)`, dark engraved text `#241a08`, 1px `#5c4726` border,
  `inset 0 1px 0 rgba(255,240,200,.55)` top shine. Secondary: stone + bronze.
  Danger: oxblood on stone.
- **Tabs**: LoL underline — small-caps, inactive `--ink-faint`, active
  `--gold-hi` with a 2px gradient underline (transparent→gold→transparent).
- **Item tile**: dark well `linear-gradient(#1b1611, #14100c)`, rarity-colored
  1px border + tiny rotated corner gem, faint inner glow in the rarity hue.
  2px radius.
- **Tooltip**: `--void` ground, bronze border, name in rarity color (Cinzel
  small-caps), engraved divider, affixes in `--ink-dim`, passive italic
  arcane, sell price gold.
- **Stat ledger (PoE)**: small-caps label left, dotted leader (radial-gradient
  dots), tabular value right. Section headers gold.
- **Keycap hint**: stone gradient, bronze border with 2px bottom, Cinzel 11px.
- **Motion**: 120ms ease-out everywhere; glow pulse reserved for legendary
  items; respect `prefers-reduced-motion`.

## Screen migration map

Phase 1 (the screens you live in): main menu (season poster: three framed
"contracts"), System Shop (LoL shelf + gold Purchase + drawn build-tree
connectors), Crawler Profile (PoE ledger), HUD chips/cockpit (bronze plaques;
XP bar lore-blue).

Phase 2: run recap (LoL victory verdict + standings ledger), constellation
(socketed gems), draft/sponsor offers (contract cards, wax-seal accent),
ticker/banner/bossbar (broadcast lower-thirds, D4 endcaps), keybinds
(engraved keycaps), rivals standings + downed overlay (drawn icons, plaque).

Guardrails: zero sim changes; headless before/after screenshot per screen;
no scrollbars (house rule); both hosts keep working. New icons needed to
retire emoji: crossed-swords (party), two-coins already exists (◈), skull
(downed), laurel/finish (rivals), shopping-basket (shopping), arrow-marker
(you), star/rank pips as SVG.
