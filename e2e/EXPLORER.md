# Kompl explorer runbook

A guided, read-only walk through a running Kompl, done one step at a time by a
reviewer who looks at each screenshot and judges it, the way the demo-film
recordings found bugs: by someone using the real app and noticing what looks
wrong. The crawler (`npm run crawl`) catches what a machine can measure; this
tour is for what needs eyes: wrong or empty text, overlap, cut-off labels,
misleading wording, numbers that disagree between screens, dead ends, focus
loss.

## Rules

- **Read-only.** Never add, save, import, export, compile, retry, approve,
  restore, archive or delete anything; never change a setting. The helper
  refuses such controls (exit code 2, `REFUSED`) and aborts any
  POST/PUT/PATCH/DELETE the page sends; a refusal means "move on", never "find
  another way in".
- **Never use `http://localhost:3130`** (the film wiki). The helper refuses that
  port.
- No LLM calls and nothing paid: the tour only reads.
- Judge from the screenshot first, then the `.aria.yml` and `.log.txt`. A
  finding without a screenshot path is not a finding.

## Setup

```sh
cd e2e
npm install                 # once; uses the Chromium already in the Playwright cache
npm run crawl -- --base http://localhost:3000            # the automatic part
npm run explore-step -- start --base http://localhost:3000 --width 1280 --height 800
```

The crawler writes `out/<run>/index.html` (findings by severity, each with its
screenshot) and `out/<run>/findings.json`. Read its findings before the tour:
the tour need not re-find them, and they point at screens worth a closer look.

From Git Bash, a leading `/` in an argument is rewritten to the Git folder; the
scripts undo that, or set `MSYS_NO_PATHCONV=1`.

## The step helper

`npm run explore-step -- <action> [args] [--session <name>]`

| Action | What it does |
|---|---|
| `start [--base URL] [--width W] [--height H] [--path /x] [--restart]` | opens a guarded browser that stays open between steps, then goes to `--path` |
| `goto <path>` | opens a screen of the app (`/wiki/graph?focus=<id>`, `/settings#mcp`); the API is refused |
| `click <target>` | clicks, after the denylist check |
| `hover <target>` | moves the pointer there |
| `press <key> [target]` | a key (`Tab`, `Escape`, `ArrowRight`, `Enter`); Enter/Space count as a click |
| `type <target> <text>` | fills a field without submitting (refused on `/settings`) |
| `scroll <dy> [target]` | scrolls the page, or a scrollable element |
| `back`, `forward`, `reload` | browser history |
| `resize <w> <h>` | changes the viewport (1024x768 small laptop window, 1280x800 laptop, 1920x1080 desktop; Kompl is desktop-browser only) |
| `snap [--full]` | captures the current state again (full page with `--full`) |
| `nodes` | lists the page dots on the topic map with their screen positions |
| `stop` | closes the browser |

Targets: `role:<role>:<name>` (exact accessible name, e.g. `role:button:Zoom in`),
`text:<text>`, `label:<text>`, `placeholder:<text>`, `css:<selector>`,
`node:<page title or id>` (a dot on the map), `xy:<x>,<y>` (viewport px). Add
`@n` for the n-th match (`text:Show all@1`). Names come from the `.aria.yml`
of the previous step.

Every step waits until the page is quiet (no request in flight, no DOM change
for 500 ms), then writes, under `out/explore/<session>/`:

- `NN-<action>.png`: the screenshot to judge,
- `NN-<action>.aria.yml`: the accessibility tree (roles, names, states),
- `NN-<action>.log.txt`: URL, viewport, quiet or not, **where keyboard focus
  is**, console errors, failed or 4xx/5xx requests and guard blocks since the
  last step.

Exit codes: 0 done; 1 the step failed (the state is still captured; Playwright's
reason, such as "`<div>` intercepts pointer events", is often itself a finding);
2 refused by the guard.

## How to judge each step

Open the screenshot and ask, in this order:

1. **Did the step do what a user expects?** The panel opened, the page changed,
   the number moved. If not, that is the finding.
2. **Text:** empty boxes, placeholder or raw values (`undefined`, `NaN`, ids
   instead of titles, `[object Object]`), wrong pluralisation ("1 pages"),
   labels cut off without "…", text overlapping other text or icons.
3. **Wording that misleads:** a sentence Kompl wrote shown as if it were the
   source's words (in quotes, or with no "Kompl's summary, from …" label); a
   button named for something it does not do; a status that contradicts
   another screen.
4. **Numbers:** does every count on this screen agree with the list under it,
   and with the same count on other screens? Note each count you see; compare
   at the end (see "Numbers that should agree").
5. **Layout:** overlap, controls hidden behind panels, content past the screen
   edge, a sideways scroll in a small window, a sticky bar covering what it should not.
6. **Dead ends:** a screen with no way forward or back, an empty state with no
   hint of what to do, a link that leads to "not found".
7. **Focus:** `focus:` in the log after each keyboard step. `body` after a
   panel closes or a dialog ends means focus was lost.
8. **The log:** any console error or failed request is worth a line, even when
   the screen looks fine.

## The tour

Use `--session tour`. Start at 1280x800; each stop says when to try 1024x768.

1. **Onboarding, without submitting.** `goto /onboarding`. Judge the source
   cards (names, subtitles, which can be chosen). Do not press Next or Save &
   Continue: open each later screen directly with a throwaway session id:
   `goto /onboarding/health?session_id=explore-ro`,
   `/onboarding/url?session_id=explore-ro` (type two URLs into the box; does
   the "URLs detected" count match?), `/onboarding/paste?…`,
   `/onboarding/file-upload?…`, `/onboarding/bookmarks?…`,
   `/onboarding/review?session_id=explore-ro` (empty review: is the empty
   state clear, is there a way back?). `resize 1024 768` on two of them.
2. **Dashboard** `goto /`. Stat tiles, recent sources, banners (stale sources,
   service health), activity. Write down every count. Banners that cannot be
   dismissed, or that say something false, are findings.
3. **Wiki index** `goto /wiki`. Categories and their counts, the sidebar
   (collapse, "Show archived" is a view switch and allowed), each card's
   title and summary. `resize 1024 768`: does anything run off the screen?
4. **Three articles:** the best connected page (first in `nodes`, or the
   largest "Connections" count), a small page, and a source-summary page. On
   each: title, "On this page", citation markers `[n]` against "Sources (N)",
   the right-hand card: Connections count against the rows, each group's
   label, a `Why` toggle (`click "css:summary[aria-label^='Why']"`): the
   sentence must be labelled "Kompl's summary, from <source>", never shown as
   a quote; "no page yet" rows; Disputes; "You might also read"; "See in
   graph". `resize 1024 768` on one article.
5. **Topic map** `goto /wiki/graph`. Header "N pages · M connections" against
   the legend's counts; `nodes`; `hover node:<title>` (the name card); `click
   node:<title>` (its panel: title, connections, the `Why` evidence wording);
   `press Escape` (panel closes, `focus:` not `body`); click a line (`click
   xy:<middle of two dots>`; the evidence panel's wording); Focus, `1 hop` /
   `2 hops`, `Full map`, `back`; "Connect two pages" with two titles; a legend
   filter that hides the open page and shows it again; "How to read the map";
   zoom buttons; `resize 1024 768` (header wraps, zoom buttons and filters still
   reachable). The map is drawn on a canvas, which the crawler cannot read:
   names and category labels cut off at the canvas edge or drawn over each
   other are for your eyes only.
6. **Search** `goto /wiki/search?q=<a word from a title>`, then a word with no
   results, then an empty query. Snippets, highlighting, the no-results text.
7. **Sources** `goto /sources`, then one source page. Counts against the list,
   each source's pages, dates. The action buttons (Recompile, Archive, Delete)
   are refused: judge only how they look and what they say.
8. **Feed and sessions** `goto /feed`, `goto /sessions`. Row wording, times
   (time zone, "in the future"), statuses that contradict the dashboard.
9. **Settings, read-only** `goto /settings`. Section links (`On this page`
   anchors are fine), "Connect your AI" / MCP: do the instructions and the
   config snippet look complete and correct; is the "Let AI agents add
   sources" switch state shown clearly (never toggle it). AI model & spend,
   the page-update card's estimate, Backup & restore: judge text and numbers
   only.
10. **Keyboard pass** on `/wiki` and `/wiki/graph`: `press Tab` ten times;
    each `focus:` line should name the next control in reading order, and the
    screenshot should show a visible focus ring.

End with `npm run explore-step -- stop --session tour`.

## Kompl facts to judge against

- The site sets `zoom: 0.9` on `<html>`; the topic map resets it to 1. Text
  that looks slightly small is expected; text clipped by the zoom is not.
- A relation's sentence (in the page card, the map's panels, the evidence
  list) is written by Kompl's extraction model: it must say "Kompl's summary,
  from <source title>" and never appear as a quotation of the source.
- "no page yet" marks a name with no article; it should not link anywhere.
- **Numbers that should agree:** the wiki's page count (dashboard, `/wiki`)
  with the map's header plus its hidden "Source pages" (legend); "Sources (N)"
  on an article with its numbered list and the highest `[n]` marker; an
  article's Connections count with the pages listed under its relations and
  with the focused map's page count minus one; the dashboard's source count
  with `/sources`.

## Findings template

Write findings to `out/explore/<session>/findings.md`, one block each:

```md
### <one-line title: what is wrong, where>
- Severity: critical | high | medium | low
- Screen: <route> @ <width>x<height>
- Step: NN `<action>` · Screenshot: out/explore/<session>/NN-<action>.png
- What I see: <the exact text or layout, quoted>
- What I expected: <and why: another screen, the wording rules above, common sense>
- Why it matters: <what a user would believe or be unable to do>
- Repro: <the explore-step commands from start>
- Confidence: sure | likely | needs a human look
```

Severity: **critical** the screen is broken or shows an error; **high** a
user is misled or blocked (wrong numbers, misleading wording, a dead end,
a control that does nothing); **medium** visibly broken layout or focus
loss; **low** polish (alignment, spacing, a tooltip missing).
