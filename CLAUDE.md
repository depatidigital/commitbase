# CLAUDE.md

## Glossary: UI label vs code name

The UI and its URLs were renamed; the code, API and database were not. Old URLs (`/projects`, `/project/:id`, `/application/:id`, …) redirect in `App.tsx`. Use the UI word in `t("…")` text, the code word everywhere else.

| UI (en / id) | Code, API, DB |
|---|---|
| Workspace / Workspace | `Organization`, `/api/organizations`, route `/organizations` |
| App / Aplikasi | `Source` ("project"), `/api/sources`; routes `/apps`, `/apps/new`, `/apps/:id` |
| Service / Layanan | `Application`, `/api/applications`; routes `/services`, `/services/:id` (→ `/apps/:sourceId?service=`), `/apps/:id/services/new` |

## Translations

- Skip Indonesian translations (`frontend/src/locales/id/*.ts`) for new UI strings until the user asks for a translation pass. Wrap strings in `t("…")` as usual; missing entries fall back to English.
