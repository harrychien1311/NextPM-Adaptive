# NextPM Adaptive — API reference

Base URL: `http://localhost:4000/api`
All endpoints except `/auth/*` and `/health` require `Authorization: Bearer <token>`.
Errors return `{ "error": { "message": string, "details"?: unknown } }`.

Account roles (`User.role`): `PROGRAM_OWNER` creates programs and projects and may open every
workspace; `PROJECT_OWNER` creates projects and may open only the ones it owns or was granted;
`ADMIN` manages accounts and is refused on every delivery route. Project roles
(`ProjectMember.role`) are separate: `OWNER` may write, `MEMBER` / `VIEWER` may read.

## Auth

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }` |
| POST | `/auth/register` | `{ email, name, password, jobTitle? }` | `{ token, user }` — always creates a `PROJECT_OWNER`; the role can never be chosen here |
| GET | `/auth/me` | — | `{ user }` |
| GET | `/health` | — | `{ status, env, time }` — unauthenticated; this is the container health check |

## Admin console (`ADMIN` only)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/admin/users` | every account with its role, status and project counts |
| POST | `/admin/users` | `{ email, name, password, jobTitle?, role }` — the only way a `PROGRAM_OWNER` or `ADMIN` account is created |
| PATCH | `/admin/users/:userId` | `{ name?, jobTitle?, role?, active? }` — refuses self role-change / self-deactivation and demoting the last admin |
| POST | `/admin/users/:userId/password` | `{ password }` — administrator password reset |
| DELETE | `/admin/users/:userId` | refuses self-deletion, the last admin, and any account that still owns projects (deactivate instead) |

## Customer reference library

Each customer's checklists and document templates, uploaded once and reused by every project for
them. **Readable by any signed-in account** — a project owner needs to see what their project will
be assessed against. **Writable only by `PROGRAM_OWNER` and `ADMIN`**: the library is configuration
rather than delivery data, which is the one place an administrator touches something outside the
account console.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/customers` | every customer with their checklists (and item counts), templates (with the placeholders found in each) and whether a logo is set |
| GET | `/customers/resolve?customer=…` | what the library holds for a **free-text** customer name. Returns `{ matched, typed, confidence, matchedOn, customer }`, where `confidence` is `exact` \| `prefix` \| `partial` \| `default`. A suggestion for the PM to confirm — never applied on its own |
| POST | `/customers` | `{ name, key?, aliases? }` — `key` is derived from the name when omitted |
| PATCH | `/customers/:customerId` | `{ name?, aliases?, active? }` |
| DELETE | `/customers/:customerId` | cascades the checklists, items and templates, and removes their stored files |
| POST | `/customers/:customerId/checklists` | multipart `file` (+ `name`) — `.xlsx` / `.docx`. Parsed on upload into `ChecklistItem` rows **and translated into English** in the same step; the response carries the item count and the parse note. A new upload **supersedes** the previous version rather than replacing it |
| GET | `/customers/checklists/:checklistId/items` | the parsed rows, so the upload can be checked against the original |
| POST | `/customers/checklists/:checklistId/translate` | writes the English reading of every item. The upload does this on its own; this route is for a checklist uploaded before the app held English readings, or one whose translation failed. Costs one model call |
| DELETE | `/customers/checklists/:checklistId` | |
| POST | `/customers/:customerId/templates` | multipart `file` + `documentType` — `.pptx` / `.docx` / `.xlsx`. Scanned for placeholders; each is reported with its occurrences, locations and whether it is **split across text runs** (which filling must handle) |
| DELETE | `/customers/templates/:templateId` | |
| POST | `/customers/:customerId/logo` | multipart `file` — `.png` / `.jpg` / `.svg` / `.webp` |
| GET | `/customers/(checklists\|templates\|logo)/:id/file` | the stored original. 404 with an explicit message if the row exists but its file is missing from `UPLOAD_DIR` |

**An alias is a spelling or a rule.** `SK C&C` matches that exact name; `SK*` matches any name
starting with SK (longest prefix wins, so a later `SKAX*` beats a broader `SK*`); `*` is the house
default, used only when nothing else matched. Templates and branding fall back to the house
default; the customer checklist and the customer proposal deliberately do not, because auditing a
project against a checklist we fell back to would put a meaningless number in front of the PM.

## Programs & projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/programs/overview` | program groups, project cards, roll-up summary and `capabilities`; every card carries `canOpen`, `canEdit` and `canDelete` |
| POST | `/programs` | `{ name, description?, targetOutcome? }` — `PROGRAM_OWNER` only |
| PATCH | `/programs/:programId` | `{ name?, description?, targetOutcome? }` — `PROGRAM_OWNER` only; renaming re-slugs `key`, which must stay unique (409 otherwise) |
| DELETE | `/programs/:programId` | `PROGRAM_OWNER` only. **Does not delete its projects** — `Project.programId` is `SetNull`, so they become standalone. Returns `{ deleted, name, projectsReleased }` |
| POST | `/projects` | `{ name, type: SI\|SM\|PRODUCT, programId?, customer?, targetStart? }` — the caller becomes the project owner; provisions the input profile, tasks, domain readiness and dashboard layout |
| GET | `/projects/:projectId` | workspace header, readiness and its `basis`, `preferredApproach`, and the caller's own `projectRole` — which the UI uses to lock what a reader cannot do |
| PATCH | `/projects/:projectId` | `{ name?, status?, summary?, customer?, targetLabel?, programId?, type?, preferredApproach? }` — project role `OWNER`. `type` changes which input schema and document catalog apply; `preferredApproach: ""` is stored as **null**, which is what asks the analysis to recommend a model |
| DELETE | `/projects/:projectId` | **Irreversible**: inputs, uploads, analyses, decisions, documents and the audit trail all cascade. Stricter than PATCH — only the project's own `ownerId` or a `PROGRAM_OWNER`, so a co-owner member gets 403. Returns `{ deleted, name, documentsRemoved }` |
| GET | `/projects/:projectId/members` | project team |
| POST | `/projects/:projectId/members` | `{ email, role?: OWNER\|MEMBER\|VIEWER }` |
| DELETE | `/projects/:projectId/members/:userId` | the project owner cannot be removed |

## Flow 1 — Project Input

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/input` | fields, counters, custom fields, reference groups, description document, plus `customer` and any pending `customerSuggestion` |
| PUT | `/projects/:id/input` | `{ values: [{ definitionId, value }] }` — saves as `PM_INPUT`, **verified on save** |
| POST | `/projects/:id/input/customer-suggestion` | `{ action: "accept" \| "dismiss", value? }` — the PM's decision on the customer the analysis read from the documents. **Accepting is the only thing that writes `Project.customer`**, which is what makes that customer's checklist and templates apply; `value` lets the PM correct the proposed name first. Both write an `AuditEvent` |
| POST | `/projects/:id/custom-fields` | `{ name, value?, useIn: RULES\|DOCUMENT\|BOTH }` |
| DELETE | `/projects/:id/custom-fields/:fieldId` | |
| POST | `/projects/:id/actions/:actionId/resolve` | `{ value }` — writes the answer back into the input profile |
| POST | `/projects/:id/references` | multipart: `file`, `group: COMMITMENT\|SCOPE\|ORGANIZATION\|SCHEDULE\|OTHER`. Max 2 readable files per group; **an upload first clears the group's unreadable files**, since a file whose text could not be extracted can never contribute anything |
| GET | `/projects/:id/references/:fileId` | metadata + the text extracted on upload, for the preview panel |
| GET | `/projects/:id/references/:fileId/file` | the original bytes, `Content-Disposition: inline` so a PDF opens in the browser viewer |
| DELETE | `/projects/:id/references/:fileId` | also removes the project description document |
| POST | `/projects/:id/description` | multipart: `file` — the project description document. **Mandatory**: the analysis refuses to run without one |
| POST | `/projects/:id/input/verify` | *legacy*. The two-stage extraction behind the removed *Verify input* button. Still mounted; no screen calls it |

Uploads accept `.pdf`, `.doc`, `.docx`, `.xls`, `.xlsx`, `.ppt`, `.pptx`, `.txt`. Text is read from
`.txt`, `.pdf`, `.docx`, `.xlsx` and `.pptx`; the pre-2007 binaries and scanned PDFs are stored and
flagged rather than silently accepted.

## Flow 2 — Planning Review

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/projects/:id/planning/analyze` | **the main path.** Reads every uploaded document plus the typed inputs and returns the overview, the approach advisory, the planning gaps and the document findings as one `AiApproachSuggestion` snapshot. 400 when no readable document has been uploaded. **No mock fallback** — a missing API key is an error, not a plausible-looking analysis |
| GET | `/projects/:id/approach` | `{ evaluation, options[], decision }` — what the Planning Review screen renders |
| POST | `/projects/:id/approach/decide` | `{ approach, outcome: CONFIRMED\|OVERRIDDEN, rationale? }` — rationale required for an override; freezes the document pack |
| POST | `/projects/:id/approach/evaluate` | *legacy* Skill 1: governance-model recommendation only. Still mounted; no screen calls it |

`evaluation.recommendedApproach` (and every `options[].approach`) is a free-form governance-model
string — `WATERFALL`, `SCRUM`, `KANBAN`, `HYBRID`, `ITERATIVE`, `STAGE_GATE` by default, or another
the AI justified from evidence. `options[]` **always includes the model the project currently runs
on**, even when the newest analysis did not score it, so the confirm button can never act on a
different model than the one on screen.

```json
{
  "evaluation": {
    "approachMode": "RECOMMENDED",
    "recommendedApproach": "HYBRID",
    "confidence": 86,
    "confidenceLevel": "HIGH",
    "summary": "Read 2 documents: a Korean operations SOW and a scope annex.",
    "reasons": ["Fixed price with milestone acceptance, but iteration inside each stage"],
    "evidence": [
      {
        "english": "The contract is fixed price with milestone acceptance.",
        "original": "계약은 고정가이며 마일스톤 검수로 진행된다.",
        "source": "SKB_IT_Application_SOW.pdf"
      }
    ],
    "overview": [
      { "key": "scope", "label": "Scope", "summary": "…", "points": ["…", "…"] }
    ],
    "planningGaps": [
      {
        "title": "No escalation path is defined",
        "why": "The SOW names a 24×7 service but no one to escalate to after hours.",
        "documentName": "Change / Escalation Flow",
        "severity": "HIGH"
      }
    ],
    "findings": [
      { "title": "Go-live date disagrees between documents", "detail": "…", "evidence": [] }
    ]
  }
}
```

In `PM_CHOSEN` mode — the PM named a model on Project Input — `approaches` holds exactly one entry,
`evidence` is empty by design, and no alternatives are offered.

## Flow 3 — Generate & approve

A document's unknown facts come back as **gaps**: the model writes the literal token `{{gap:N}}`
into the prose instead of inventing anything, and returns
`document.gaps = [{ token, question, answer }]`. Answer them with `POST …/gaps`, then write them in
with `POST …/fill`. Gap questions are always written in English.

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/documents?domain=GOVERNANCE` | catalog, current document state (including `document.gaps` and `document.structuredData`), domain tab counts, the `customerTemplate` that will be filled, and `inPlanningGap` — true when the last analysis named this document as missing, which is what the Studio filters on |
| GET | `/projects/:id/documents/:definitionId/fit` | project type / approach / rigor controls for the banner |
| POST | `/projects/:id/documents/generate` | `{ definitionId }` — the model picks the structure itself; no template, no section contract. 400 if a required action item blocks this document, 409 if the document is already approved |
| PUT | `/projects/:id/documents/:documentId/sections` | `{ sections: [{ title, content }] }` — "Edit content" |
| POST | `/projects/:id/documents/:documentId/gaps` | `{ token, answer }` — recorded only; the document is not changed yet |
| POST | `/projects/:id/documents/:documentId/fill` | substitutes every answered token into the blank it came from — in section text, in the RACI / risk tables, in the register grid and in the org chart's person cells. 400 if nothing is answered |
| POST | `/projects/:id/documents/:documentId/approve` | only from `PM_REVIEW` |
| GET | `/projects/:id/documents/:documentId` | full draft with sections, plus `exportFormat` and `templateFill` |
| GET | `/projects/:id/documents/:documentId/export` | the real Office file, rendered on demand at any status. The **server** picks the container and reports it in `Content-Type` and `Content-Disposition` |
| GET | `/projects/:id/documents/:documentId/export.docx` | forces the Word rendering |
| GET | `/projects/:id/documents/:documentId/export.xlsx` | forces the spreadsheet rendering |
| GET | `/projects/:id/documents/:documentId/sheets` | the sheets of a document filled from a customer **workbook**, read out of the real rendered file — what the workbook preview draws |
| GET | `/projects/:id/documents/:documentId/slides` | the slides of the rendered deck. Still mounted and still working; **no screen calls it** — a deck has no on-screen preview, because slides are layout and branding and a column of bullet points conveys neither |
| GET | `/projects/:id/dashboard/export.html` | the project overview dashboard as a self-contained `.html` file |
| POST | `/projects/:id/exports` | `{ format: DOCX\|XLSX\|PDF\|CONFLUENCE }` — approved documents only, recorded as an `ExportJob` |

**Download format is the server's decision**, keyed on the catalog name:

| Name matches | Exports as |
| --- | --- |
| a register in `data/table-documents.ts` | `.xlsx` — every row is one entry |
| `/raci/i` | `.xlsx` — a matrix belongs in a grid |
| `/\bdeck\b\|kick.?off/i` | `.pptx` — never falls back to Word |
| `/organi[sz]ation chart\|org chart/i` | `.pptx` — drawn as a real chart |
| everything else | `.docx` |

A document backed by a customer template overrides all of it and downloads as that template's own
file type. No exported file carries the PM question list; unanswered blanks render in place as a
highlighted "[ answer needed ]".

## Customer readiness

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/checklist` | how far this project meets what **its customer** requires: every item with both languages, its verdict, the evidence it rests on and who decided it, plus per-section scores. Returns `{ applies: false, reason }` when the project's customer has no checklist in the library |
| POST | `/projects/:id/checklist/assess` | `{ onlyOpen?: boolean }` — scores the project against the checklist. Runs in batches of 40 items. **No mock fallback**: without a model, items stay `UNKNOWN` and the UI says so |
| POST | `/projects/:id/checklist/items/:itemId` | `{ status, note? }` — the PM's own verdict, which outranks the model's |

## Dashboard, activity and agent

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects/:id/dashboard` | readiness verdict and its `basis`, document progress **counted over the documents the analysis says are needed**, tasks, actions, domain bars, activity, widget layout, and `library` — every document attached to the project, tagged `origin` and `kind` |
| PUT | `/projects/:id/dashboard/layout` | `{ widgets: { readiness: true, ... } }` |
| GET | `/projects/:id/activity?limit=30` | audit trail |
| GET | `/projects/:id/agent/sessions` | the caller's chat threads, newest activity first |
| POST | `/projects/:id/agent/sessions` | starts a thread; titled from its first question |
| GET | `/projects/:id/agent/sessions/:sessionId/messages` | one thread's messages; 403 if it belongs to another user |
| POST | `/projects/:id/agent/sessions/:sessionId/messages` | `{ question }` — the thread's earlier turns are replayed. The reply is advisory; `meta.decisionApplied` is always `false`. The agent answers in the language the PM wrote in — a conversation is not a page |
| PATCH | `/projects/:id/agent/sessions/:sessionId` | `{ title }` |
| DELETE | `/projects/:id/agent/sessions/:sessionId` | messages cascade |

## Status codes

`200` ok · `201` created · `400` validation or blocked precondition · `401` missing/expired token ·
`403` role not allowed · `404` not found · `409` unique conflict or regeneration of an approved document.
