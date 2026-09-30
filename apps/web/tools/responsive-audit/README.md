# Responsive audit

An automated responsive stress test for the Ruchoir web client. It does not ask "does the
page fit on a phone"; it checks that the layout stays usable, readable and coherent at **every**
width a real user can produce, and flags the exact spots to review.

## What it does

For every UI state (login, onboarding, each app view, each modal) it sweeps a wide matrix of
viewports (320 -> 3840 px, both orientations, several zoom levels, plus the neighbourhood of
every CSS breakpoint) and runs an in-page probe that detects:

| Rule                | Severity | What it catches                                             |
| ------------------- | -------- | ---------------------------------------------------------- |
| `document-overflow` | critical | The page scrolls horizontally (almost always a bug).       |
| `element-overflow-x`| major    | A specific element spills past the left/right edge.        |
| `text-overflow`     | major    | Text visibly overflows its box (not an intended ellipsis). |
| `touch-target`      | minor    | An interactive control is smaller than 44x44 on touch.     |
| `overlap`           | major    | Two interactive controls visibly overlap.                  |

It also runs UX / accessibility checks (finding `category: "ux"` or `"a11y"`), not just mechanical
layout:

| Rule                        | Severity | What it catches                                                       |
| --------------------------- | -------- | --------------------------------------------------------------------- |
| `low-contrast`              | minor    | Text vs background below WCAG AA (4.5:1, or 3:1 for large).            |
| `tiny-text`                 | minor    | Visible text smaller than 12px.                                       |
| `dialog-overflows-viewport` | major    | A dialog taller than the viewport (its actions are cut off).          |
| `accessible-name`           | major    | An interactive control exposes no accessible name (WCAG 4.1.2).       |
| `icon-contrast`             | major    | A meaningful icon below 3:1 against its backdrop (WCAG 1.4.11).        |
| `img-alt`                   | major    | A content image with no `alt` attribute at all.                       |

Plus screen-reader structure checks (`category: "a11y"`), so a blind user can navigate and operate the app:

| Rule                    | Severity | What it catches                                                     |
| ----------------------- | -------- | ------------------------------------------------------------------- |
| `html-lang`             | major    | `<html>` has no lang (wrong speech synthesiser).                    |
| `landmark-main`         | major    | No (or more than one) main landmark to skip to.                     |
| `heading-order`         | major    | No h1, or a skipped heading level.                                  |
| `aria-hidden-focusable` | major    | Focus can land on content hidden from the screen reader.            |
| `aria-ref-broken`       | major    | `aria-labelledby`/`describedby`/`controls` points at a missing id.  |
| `duplicate-id`          | major    | A repeated id breaks label/ARIA associations.                       |
| `dialog-name`           | major    | A dialog with no accessible name.                                   |
| `positive-tabindex`     | minor    | A positive tabindex reorders the focus sequence.                    |

These are theme-dependent, so the audit can sweep every shipped theme (`--all-themes`): contrast and
icon legibility are re-measured under the eight themes (four accents, by day and by night). A caveat the probe
enforces by construction: dim icons/text via `opacity` is invisible to a contrast check (the computed
`color` is unchanged), so de-emphasis must use a colour token, not `opacity`.

It also records JS/console errors and cumulative layout shift (CLS) per combination, screenshots
only the suspect ones, and writes a `report.json` plus a self-contained `report.html` gallery for
a fast, targeted visual review.

The runner exits non-zero when a **critical** issue or a JS error is found, so it can gate CI.

## Requirements

Playwright is a dev-only dependency (never shipped in the production static export). Install it
once (uses the latest stable, currently 1.62.x):

```bash
pnpm --dir apps/web add -D playwright
pnpm --dir apps/web exec playwright install chromium
```

## Run it

The app is a state machine with no URL routes, so the audit reaches each screen through the dev
deep-link (`lib/dev/deeplink.ts`), which only exists in development. Start the dev server, then
run the audit against it:

```bash
pnpm --dir apps/web dev            # terminal 1
pnpm --dir apps/web audit:responsive   # terminal 2
```

Open the report it prints at the end (`tools/responsive-audit/report/report.html`).

If the dev server is on another port, point the audit at it with `--url`, or set `AUDIT_URL` / `PORT`
once (handy for a random port):

```bash
# explicit flag
pnpm --dir apps/web audit:a11y -- --url http://localhost:46789 --quick

# or via an env var (no flag needed)
AUDIT_URL=http://localhost:46789 pnpm --dir apps/web audit:a11y -- --quick
PORT=46789 pnpm --dir apps/web audit:responsive
```

### Flags

| Flag              | Effect                                                                        |
| ----------------- | ----------------------------------------------------------------------------- |
| `--url <url>`     | Base URL. Default: `$AUDIT_URL`, else `http://localhost:$PORT`, else `:3000`.  |
| `--quick`         | Fast, representative subset of widths (320/375/768/1024/1280/1440/1920).      |
| `--tag <t,...>`   | Keep only viewports with every tag (`quick`, `zoom`, `mobile-portrait`, ...). |
| `--state <id,...>`| Keep only these states (`files`, `login`, `channel`, ...). Ids in `states.mjs`.|
| `--reload`        | Reload per viewport instead of resizing in place (slower, stricter).          |
| `--headed`        | Show the browser window.                                                      |
| `--fail-on <lvl>` | Exit non-zero on `critical` (default), `major`, or `none`. Used to gate CI.    |
| `--themes <t,...>`| Sweep these themes (`sky`, `mint`, `violet`, `pink`, each also with `-dark`). Default `sky`.|
| `--all-themes`    | Shorthand for every shipped theme.                                            |
| `--fail-rules <r,...>` | Exit non-zero if any finding matches these rules, whatever the severity.  |

Examples:

```bash
# Fast pass while iterating on one screen:
pnpm --dir apps/web audit:responsive -- --state files --quick

# Only the mobile-portrait widths, full set:
pnpm --dir apps/web audit:responsive -- --tag mobile-portrait

# Accessibility across every theme, failing on the hard a11y blockers:
pnpm --dir apps/web audit:a11y -- --quick --fail-rules accessible-name,icon-contrast,img-alt,low-contrast,dialog-overflows-viewport
```

## CI

Two jobs in `.github/workflows/ci.yml` run this against a `next dev` server on every push/PR and
upload the report as a build artifact:

- `responsive` (`--quick --fail-on critical`): gates only on critical issues (horizontal page
  overflow, JS errors), so the known `major` backlog does not block the pipeline while the layout is
  built out; tighten to `--fail-on major` once that backlog is cleared.
- `a11y` (`audit:a11y --quick --fail-rules ...`): sweeps all four themes and targets the hard a11y
  blockers (accessible names, icon/text contrast, unreachable dialogs, and the screen-reader structure
  checks: language, landmarks, headings, ARIA integrity). Required: the audit is green, so any regression
  on those rules blocks the PR. The `touch-target` and `tiny-text` buckets stay advisory (density
  trade-offs), so they are not in `--fail-rules`.

## Files

- `viewports.mjs` - the width/height/zoom matrix and breakpoint-neighbour generation.
- `states.mjs` - the list of UI states and their deep-link queries.
- `probe.mjs` - the in-page detector (runs in the browser; fully self-contained).
- `run.mjs` - the orchestrator (Playwright): navigate, resize, probe, screenshot.
- `report.mjs` - the JSON + HTML report writers.
- `report/` - generated output (git-ignored).

## How to read the results

1. Fix `critical` first: a horizontally scrolling page usually points at one unconstrained
   element (fixed width, `white-space: nowrap`, an image or a table). The `element-overflow-x`
   findings in the same run name the culprit.
2. Then `major`: overlaps and text spilling out of their boxes.
3. `touch-target` and `minor` are polish for the mobile pass.

The point is to build the responsive layout **against the content**: fix the width where the
content starts breaking, not around a specific device size.
