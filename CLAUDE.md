# CLAUDE.md

## Glossary: UI label vs code name

The UI was renamed; the code, API and database were not (yet). Use the UI word in `t("…")` text, the code word everywhere else.

| UI (en / id) | Code, API, DB |
|---|---|
| Workspace / Workspace | `Organization`, `/api/organizations`, route `/organizations` |
| App / Aplikasi | `Source` ("project"), `/api/sources`, routes `/projects`, `/project/:id` |
| Service / Layanan | `Application`, `/api/applications`, routes `/application/:id`, `/applications` |

## Translations

- Skip Indonesian translations (`frontend/src/locales/id/*.ts`) for new UI strings until the user asks for a translation pass. Wrap strings in `t("…")` as usual; missing entries fall back to English.
