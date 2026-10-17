# IEEE Day event overrides

These event-specific decisions override the generated `MASTER.md` where its
generic event template conflicts with this quiz's rules or local-only hosting.

## Visual identity

Use the official, locally stored IEEE Computer Society SVG at
`/ieee-cs-logo.svg`. Preserve its proportions and orange artwork. Give it clear
space, a calm light background, and enough width to remain legible. An event
wordmark, "IEEE Day / Quiz Arena", may sit separately from the official mark.

The overall identity is editorial: emphatic typography, an orange accent, ink
text, warm cream paper, thin rules, and generous breathing room. Avoid a generic
blue dashboard palette. Use large numeral treatments and small uppercase
section labels to evoke an event programme.

| Token | Value | Purpose |
| --- | --- | --- |
| Orange | `#F28C00` | Brand accent, decorative blocks, highlights |
| Orange deep | `#A84D00` | Accessible orange text on cream |
| Ink | `#171A1D` | Primary text, primary button surface |
| Warm cream | `#F7F4EE` | Page background |
| Paper | `#FFFFFF` | Inputs, raised cards, option content |
| Muted ink | `#5A5D60` | Supporting text |
| Rule | `#D8D4CB` | Borders and separators |
| Stage | `#101316` | Projector background |

Use ink text on orange primary controls. Orange alone is not sufficient
contrast for small text on cream. Select answer colors that support white
text, and verify contrast on the actual implemented colors.

## Typography and local assets

Use locally bundled Inter Variable for headings, body copy, controls, and
tables. Import the installed `@fontsource-variable/inter` package into the Vite
bundle. Use tabular numerals for clocks, scores, progress, IDs, and ranks.
Do not use the Google Fonts URL or remote CSS import shown in `MASTER.md`.
Do not fetch remote imagery, sounds, or icons at runtime. Use local Lucide SVG
icons where useful; do not introduce a sound dependency for ordinary actions.

## Player screen

On desktop, make the join view a two-column composition: a strong event title
and concise rules on the left, a focused name form on the right. The event
identity should be visible before the form. Use a large "Quiz Arena" heading,
a compact "IEEE Day · PIEAS" label, and one clear join action.

On mobile, stack the title and form with comfortable margins. Inputs use at
least 16px text, and interactive controls are at least 48px tall. After joining,
show the assigned ID prominently, with a clear waiting state and player count.

During the quiz, prioritize the question over decorative framing. Show
"Question 3 of N", a progress indicator, and the server-synchronized elapsed
timer. Put four large answer controls in a vertical stack on phones and a 2×2
grid when space permits. Positions always carry distinct shapes: triangle,
diamond, circle, and square; text moves within those positions according to the
server's seeded option order. Each shape must have a visible outline or fill,
and its accessible label must accompany the option text.

Keep correctness out of answer-lock feedback. Show "Answer locked" briefly,
then advance. The final screen gives the name, ID, correct count, total time,
and current rank. Do not introduce question countdowns, points, streaks,
speed-bonus badges, or right/wrong animation before finishing.

## Admin console

Use a practical light dashboard. Start with event status and a compact
overview of question count, players, and finishers. Make START QUIZ the visual
anchor in the control panel; give end/reset actions quieter destructive
styling and a clear confirmation state when active game data is affected.

Organize controls and the joining URL/QR near the top, followed by a wide live
player table with name, assigned ID, progress, correct count, elapsed time,
rank, and kick action. Keep names and IDs visible together. A verification
search panel must render all matching names rather than choosing the first.
The question preview is explicitly read-only and explains that editing occurs
in root `questions.json` followed by `npm run build`.

On narrow screens, let the player table scroll within its container or turn
rows into readable cards; do not make the entire page overflow horizontally.
All controls remain reachable by keyboard with visible focus states.

## Projector display

Use the dark stage palette, very large bold type, bright cream text, and
orange highlights. The lobby is centered on the LAN joining URL, scannable QR,
and live player count. The running view contains only the top-ten leaderboard
and essential quiz state. Avoid admin navigation, marketing blocks, or dense
helper copy on this screen.

Make rank, name, ID, correct count, total time, and progress readable across
the room. Use restrained transforms to animate row movement while preserving
stable player IDs as React keys. When privacy is enabled, conceal ranking,
correct counts, and times until the game has finished; retain neutral join
order and progress so the room still sees activity.

In the finished state, present a top-three podium including every winner's
name and ID. Add brief local CSS confetti. Respect `prefers-reduced-motion` by
disabling confetti movement, animated reordering, and nonessential transitions.

## Acceptance checks

- Check mobile at 375px, tablet at 768px, and desktop/projector at 1440px.
- Verify no horizontal page overflow or clipped answer text.
- Keep dark/light text contrast at least 4.5:1 for normal text.
- Use a visible focus ring and explicit labels on all form controls.
- Disabled and pending states must be clear without relying on color.
- There is no per-question time limit; omit the generated template's countdown
  and scarcity/limited-seat conversion patterns.
- Screens must work without internet after installation and build.
