# NextPM Adaptive

Full-stack implementation of the approved `NextPM_Adaptive_Developer_Handoff.html` prototype.
A PM uploads the documents a project already has, presses one button, and gets back: what the
project is, which governance model fits it, what is still missing before it can start, and what
contradicts itself across those documents. Confirming the model opens a document studio that
drafts exactly the documents the analysis said were missing.

**Core principle preserved from the handoff:** the agent verifies, recommends and drafts — the PM
confirms every decision and approves every baseline. Uploaded files never become approved facts
automatically, and the AI never applies a decision on its own.

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Database | PostgreSQL 16 + Prisma ORM | Relational hierarchy (program → project), JSON columns for analysis snapshots |
| Backend | Node 20, TypeScript, Express, Zod | Modular services, one module per planning flow step |
| Frontend | React 18, TypeScript, Vite, TanStack Query | The prototype CSS is reused byte-for-byte in `frontend/src/styles/app.css` |
| Auth | JWT + bcrypt, role-based | Only PM roles can confirm governance models and approve outputs |
| AI | Anthropic Messages API (`claude-opus-5`) | The calls that must not guess have **no** offline fallback; the rest keep a deterministic mock |

## Quick start (local)

```bash
# 1. Database
docker compose up -d db

# 2. Backend
cd backend
cp .env.example .env          # adjust DATABASE_URL / JWT_SECRET if needed
npm install
npx prisma migrate dev
npm run db:seed               # accounts, programs and project workspaces
npm run dev                   # http://localhost:4000

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:5173
```

Seeded sign-ins (all `NextPM!2026`):

| Account | Role | Sees |
| --- | --- | --- |
| `lina.vuong@nextpm.local` | Program owner | creates programs and projects; opens every workspace |
| `nam.hoang@nextpm.local` | Project owner | a `MEMBER` on two projects — the account to test the **read-only** workspace with |
| `admin@nextpm.local` | Administrator | the account console only — no project workspace |

These are recorded here, not on the sign-in screen: a login form that arrives prefilled with a
working credential publishes it to whoever opens the page.

### Everything in Docker

```bash
docker compose up --build     # web on :8080, api on :4000, db on :5432
```

### Enabling real AI

```
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-5    # the default; override only to pin something else
AI_EFFORT=medium                 # the default
```

With `AI_PROVIDER=mock` the deterministic writers in `backend/src/modules/ai/provider.ts` still
produce document drafts, so the generate-and-approve flow runs with no API key. **The planning
analysis does not** — it throws, because an invented set of planning gaps in front of a PM is worse
than an error. Note that mock is also the *failure* mode: with a bad key, the drafting calls fall
back silently, which is why `AiApproachSuggestion.aiProvider` is stored and shown as a banner.

### Database maintenance commands

```bash
npm --workspace backend run db:seed:catalog    # re-seed DocumentDefinition, prune what the catalog dropped
npm --workspace backend run db:seed:customers  # customer library from data/raw — local (non-Docker) only
npm --workspace backend run db:fix:gap-language -- --dry   # report PM questions not in English
```

`db:seed:catalog` is the one to remember: the full seed runs **only against an empty database**, so
after changing `data/document-catalog.ts` — or after deploying newer code onto an existing
database — the catalog is otherwise frozen at whatever the first boot wrote.

## Deploying to Render

`render.yaml` is a Blueprint that creates the Postgres instance, the API (from
`backend/Dockerfile`, which runs `prisma migrate deploy` on every boot) and the static frontend.
Three values it cannot know are left for the dashboard: `ANTHROPIC_API_KEY`, `CORS_ORIGIN` and
`VITE_API_URL` — the last is baked into the bundle at build time, so changing it needs a rebuild.

Two things that will bite otherwise:

- **Uploads need a persistent disk.** Render's filesystem is ephemeral, so without one every deploy
  wipes the customer templates, logos and checklists, and every document filled from a template
  then fails with "its stored file is missing".
- **The customer library does not travel with the code.** `data/raw` is outside the build context;
  re-upload the checklists, templates and logos through the Customer library screen after deploying.

## Project layout

```
nextpm/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma          # models covering the whole domain
│   │   ├── seed.ts                # base data set; catalog seeding lives here too
│   │   ├── seed-catalog.ts        # re-seed + prune DocumentDefinition only
│   │   └── fix-gap-language.ts    # one-off repair for pre-English-rule questions
│   └── src/
│       ├── data/                  # input schemas, document catalog, governance models, register columns
│       ├── lib/                   # customer matching, text extraction, OOXML fill/read/build
│       ├── modules/
│       │   ├── auth/ admin/       # login, JWT, roles; account administration
│       │   ├── program/           # program → project + access control + readiness roll-up
│       │   ├── input/             # flow 1: values, references, actions
│       │   ├── rules/             # flow 2: the planning analysis snapshot + PM decision gate
│       │   ├── documents/         # flow 3: catalog, generation, approval, Office export
│       │   ├── customer/          # the customer reference library
│       │   ├── checklist/         # scoring a project against its customer's checklist
│       │   ├── dashboard/ agent/ audit/
│       │   └── ai/                # the only file that talks to a model
│       ├── app.ts                 # route wiring, helmet, cors, rate limit
│       └── server.ts
├── frontend/
│   └── src/
│       ├── api/                   # typed client + endpoint map
│       ├── hooks/                 # useProjectWrite / useReadOnlyGuard
│       ├── pages/
│       │   ├── AdminPage.tsx      # administrator account console
│       │   ├── CustomerLibraryPage.tsx
│       │   ├── ProgramOverviewPage.tsx
│       │   └── workspace/         # DashboardView, InputView, PlanningReviewView, StudioView, AgentDrawer
│       └── styles/app.css         # design system from the handoff, unchanged
├── data/raw/                      # sample customer checklists and templates (local seeding only)
├── docs/                          # ARCHITECTURE.md · API.md · DATA-MODEL.md
├── render.yaml
└── docker-compose.yml
```

## The three planning flows

**1 · Project Input** — three fields: the project's name, its type, and the governance model the PM
has already decided on (or "not decided yet", which is a real answer — it is what asks the analysis
to recommend one). Everything else the app needs it reads from the uploaded documents, which is why
the **project description document is mandatory** and the upload panels sit above the form. Files
may be PDF, Word, Excel, PowerPoint or text.

**2 · Planning Review** — one press of *Analyze planning needs* sends every uploaded document and
the typed inputs to the model in a single call, and the screen shows what came back in three
panels: the project overview across the top, Planning Gaps and Risks & limitations bottom-left,
and the Approach Advisory bottom-right. The advisory argues a case when the PM had not decided
(four models, each with reasons and quoted evidence, switchable), and reports a fit when they had
(one model, scored on nine weighted criteria, nothing to switch to). *Confirm and open Studio*
freezes the model as the generation contract.

**3 · Planning Studio** — the Studio opens on **the documents the analysis said are missing**, plus
the kickoff deck, with every count reflecting that list rather than the full catalog; a toggle
shows everything. Each document is drafted by the model, which picks its own structure — there are
no templates and no section contract. A fact the project data does not contain becomes a
`{{gap:N}}` token plus a question for the PM, never a guess. Downloads are real Office files, and
the container is the server's decision: registers and matrices as `.xlsx`, decks and the org chart
as `.pptx`, everything else `.docx`.

## The customer reference library

A checklist belongs to a **customer**, not to a project: LGCNS's intake checklist and SKAX's
operational readiness checklist are uploaded once and every project for them is assessed against
it. Same for document templates — a customer's kickoff `.pptx` is stored as the original binary so
generation can fill it *in place*, keeping their masters, fonts and images.

A project finds its customer by **matching text, not a foreign key**: `Project.customer` is free
text, matched against each customer's aliases. An alias can be a spelling (`SK C&C`), a prefix rule
(`SK*` — a whole corporate group in one rule) or `*`, the house default. Both are edited in the
Customer library screen, so adding a customer never needs a code change.

Parsing is per-format and the formats genuinely differ — this is where "adaptive" is load-bearing:
an LGCNS `.xlsx` checklist is a grid with two blocks side by side on one sheet, while an AGS
`.docx` is prose where each check is a paragraph ending in `■ Yes No N/A`. `lib/checklist-parser.ts`
holds one strategy for each.

## Language

The interface is English whatever language the uploads are in. Where the point is traceability —
governance evidence, checklist items — the source sentence is kept *beside* the English, never
instead of it: a translation cannot be searched for in a Korean PDF. Proper nouns keep the spelling
their document uses. The chat agent is the deliberate exception: it answers in whatever language
the PM wrote in, because a conversation is not a page.

## Extending the governance-model list or a document's structure guidance

Everything the drafting prompts need is in `backend/src/data/governance-models.ts` — add a model to
`DEFAULT_GOVERNANCE_MODELS` + `GOVERNANCE_MODEL_META`, or a structure hint to
`GOVERNANCE_ARTIFACT_GUIDANCE`, and nothing else needs to change (unknown models and artifacts fall
back to a generic entry, so the app never breaks on an AI-proposed model outside the default list).
Add a register document by adding one entry to `data/table-documents.ts`: the same column list
feeds the prompt, the spreadsheet header and the on-screen grid, so those three cannot drift.

## Tests and checks

```bash
npm --workspace backend run lint     # tsc --noEmit — the only backend "lint"
npm --workspace frontend run lint
npm --workspace backend run test     # readiness formula unit tests
```

## What is intentionally left as an integration point

- **OCR for scanned documents** — `lib/extract-text.ts` pulls a text *layer* out of `.txt`,
  `.docx`, `.pdf`, `.xlsx` and `.pptx`. A scanned PDF has no text layer in any language, so the
  file is stored and flagged for re-upload. Pre-2007 binaries (`.doc`, `.xls`, `.ppt`) are a
  different container format and are not parsed.
- **Approved-baseline export** (`createExport`) still only records the job and returns approved
  content as JSON; it has not been upgraded to bundle a real multi-document package the way the
  per-document Office / dashboard `.html` downloads were.
- **File storage** — uploads go to local disk via multer (`UPLOAD_DIR`); switch `storageKey`
  handling to S3/Blob for production.
- **Prompt caching** — there is none. Every chat question re-sends the whole project context at
  full input price, and that context grows as documents are generated. A `cache_control` breakpoint
  on the project block is the largest single cost saving available.
