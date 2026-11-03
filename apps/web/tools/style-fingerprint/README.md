# Style fingerprint

Proves that a change which must not move a pixel did not: it records the computed style of every
element on the main screens (shadows, transforms, edges, radii, paddings, gaps, colours, sizes), once
before the change and once after, and compares the two.

- `run.mjs` signs in with a seeded account of the dev database (`alice@atelier.test` by default,
  `RUCHOIR_FP_EMAIL` to change it, password in `RUCHOIR_SEED_PASSWORD`: the `SEED_PASSWORD` of
  `apps/api/src/seed.rs`), opens the seeded space (`studio-rennes`) and walks its screens the way a
  person does (`STEPS`): channel, members and files panels, a direct message, space files, calendar,
  threads, mentions, saved, space settings, preferences, the user menu, search, new channel, plus a
  few hovered or focused states. It writes `<out>/<theme>/<width>/<step>.json`.
- `compare.mjs <before> <after>` prints every differing property and exits 1 if there is any.

It does not use the dev deep link (`lib/dev/deeplink.ts`): a deep link renders the shell without the
API, so a feed would be empty. The labels it clicks are the English ones (the seeded accounts' locale).
A step whose target is not on screen (the compact layout hides some) is skipped and logged.

## Before and after, on the server

The dev front (`https://ruchoir-dev.theovilain.fr`) serves the main checkout. Take the "before" from
it, or from a worktree served the same way (below); the Playwright image runs the script, with the
worktree mounted read only and the output folder owned by the caller:

```bash
docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v /tmp/fp:/out -v "$PWD/../..:/repo:ro" -w /repo/apps/web \
  -e RUCHOIR_SEED_PASSWORD='<SEED_PASSWORD>' \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  node tools/style-fingerprint/run.mjs --url https://ruchoir-dev.theovilain.fr --out /out/before
```

To take the "after" from a branch in a worktree: stop the front (`pkill -f "next dev -p 3111"`),
start `pnpm dev -p 3111` from the worktree's `apps/web`, run the same command with `--out
/out/after`, then stop it and run `ruchoir-dev web` to give the front back to the main checkout.
`next dev` rewrites `apps/web/next-env.d.ts`: restore it in the worktree before committing.

Then `node tools/style-fingerprint/compare.mjs /tmp/fp/before /tmp/fp/after`. Run the "before" twice
first and compare the two runs: the dev data is shared, and a message posted in between shows up as a
difference that has nothing to do with styles. A full run (two themes, two widths) takes about ten
minutes.
