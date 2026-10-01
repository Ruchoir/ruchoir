# ADR 0003: Euro-Office as the live editing engine, behind WOPI

- Status: accepted
- Date: 2026-10-01

## Context

Live, multi-person editing of Word, Excel and PowerPoint files is the most awaited missing piece of
Ruchoir. Nobody rewrites an office suite: the realistic path is an existing self-hosted engine, run
next to the API, that Ruchoir feeds with files and that hands back new versions. The engine has to be
part of the free AGPL core, keep golden rule 2 (European or neutral, nothing that calls home), and
reach the Microsoft Office fidelity people expect when files go back to clients.

Three engines were candidates in 2026:

- **Collabora Online** (Collabora Productivity, United Kingdom; MPL 2.0; LibreOffice-based). Mature,
  the engine of Nextcloud Office and of the German administration's openDesk.
- **Euro-Office** (a consortium led by Nextcloud and IONOS, EU; AGPL-3.0). A fork of OnlyOffice
  started in March 2026, 1.0 released on 9 June 2026.
- **OnlyOffice** (Ascensio System, Latvia, with Russian origins; AGPL with additional terms added in
  May 2026). Ruled out on golden rule 2 grounds before any test.

Collabora Online and Euro-Office were run side by side on 2026-10-01, on the project's own files,
behind a throwaway WOPI host.

| | Collabora Online (CODE 26.04) | Euro-Office 9.3.4 |
|---|---|---|
| Office fidelity | Converts to its own model; good, weaker on complex files | Works natively in OOXML |
| Look | LibreOffice with a ribbon | Close to Microsoft 365 |
| Calls home | The free edition loads its welcome and feedback dialogs from `rating.collaboraonline.com` in every user's browser and cannot switch them off without falling back to 20 connections and 10 documents | None, verified in the browser and on the engine's connections |
| Licence of the free edition | MPL, with the restriction above | AGPL, unrestricted |
| Customisation | Very flexible (CSS variables, a branding stylesheet) | Logo, themes, feature switches, all available without a licence |
| Memory at rest | 0.6 GB | 2.1 GB (4 GB recommended) |
| Image | 1.8 GB | 7 GB |
| Maturity | Years in production | Four months, five defects found in a day |

The two people driving the product tested live co-editing together on Euro-Office and kept it.

## Decision

- **Euro-Office is the engine**, run as an optional compose service (profile `office`), never
  published, reached by the browser through the API under `/office/`.
- **Ruchoir speaks WOPI**, the standard host protocol, and nothing else. Euro-Office's own
  configuration (theme, logo, feature switches) travels through WOPI's `docs_api_config` form field,
  which other engines ignore. Replacing the engine is a matter of configuration, not of rewriting
  the host.
- The design is in [`docs/office-editing.md`](../office-editing.md).

## Consequences

- The feature is free and sovereign in the sense of golden rule 2. The engine image is pulled from
  the GitHub container registry at deployment: a registry, not a runtime service, and mirrorable.
- An instance that turns the feature on needs about 4 GB of extra memory and 7 GB of disk. The
  feature is optional for that reason, and the engine runs under a memory limit.
- Euro-Office is young. The defects found are reported upstream with fixes; until released, small
  documented workarounds ship in `infra/office/patches/` and in the web client, each removed when the
  pinned version carries the fix. Collabora Online stays one configuration away if the project
  falters.
- WOPI is Euro-Office's second protocol (most of its deployments use its own API). Every engine
  upgrade is checked end to end before the pin moves.
