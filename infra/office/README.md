# Office engine files

Mounted read-only into the `office` service (Euro-Office) by `docker-compose.yml`. See
`docs/office-editing.md` and ADR 0003.

| File | What it does |
|---|---|
| `local-production-linux.json` | Engine settings Ruchoir needs: a save every 10 minutes during a long session (`autoAssembly`). Read after the `local.json` the engine writes itself. |
| `themes/theme-ruchoir-light.json` | The "Ruchoir day" theme: light top bar (the engine draws its top-bar icons with the toolbar's colour, so they vanish on a dark bar), Ruchoir greys, ink for actions, sky for selection. One theme per file: the engine gathers the folder. |
| `themes/theme-ruchoir-dark.json` | The night sibling. Not used yet: the engine does not paint a custom dark theme (upstream defect 3); by night the editor uses the engine's own dark theme. |
| `patches/editor-wopi.ejs` | Temporary fixes of the engine's WOPI page: keep the integrator's theme when the `thm` parameter is absent (defect 1), paint a custom theme given at launch (defect 2), let the asked theme win over one an earlier session stored (defect 8), keep the member's avatar round (defect 9), and give the mobile editor Ruchoir's day colours (defect 10). |
| `patches/visioeditor-index.html` | Temporary fix of the Visio viewer's page: the module configuration it lacks (defect 4). |

## Removing a patch

Each patch was taken from the engine version pinned in `AGENTS.md` and differs from it only where it
says `Ruchoir patch`. When moving the pin:

1. Check the upstream issue of each defect. If the new version fixes it, delete the patch file and
   its line in `docker-compose.yml`.
2. Otherwise, take the page from the new image (`docker create`, `docker cp`), re-apply the marked
   change, and replace the file here. Never mount a page from an older version over a newer engine.
3. Run the end-to-end check of `docs/office-editing.md` before deploying.
