# Reverse-Engineering Report: Google Deep Review (`DeepReviewUi` / Paper Assistant Tool)

## 1. Evidence Identity & Inspected Artifacts

This report documents the static and protocol reverse-engineering of Google's **Deep Review** technical paper analysis application ([research.google/deepreview](https://research.google/deepreview/)) and its underlying **Paper Assistant Tool (PAT)** pipeline ([Google Research Blog](https://research.google/blog/analyzing-technical-documents-with-deep-review/), [arXiv:2606.28277](https://arxiv.org/abs/2606.28277)).

- **REA Tooling**: `rea-agents@6.5.0` on Node.js `v24.11.1`
- **Primary REA Evidence ID**: `ev_45a4f9fa8de32d5e80a7b249a306564362831231632c9d764bcde0f9ab0ef092`
- **Combined JS Bundle Subject SHA-256**: `b3cf4f9d95579aa13da7a70489e7c891ff656a0e4280203a6ac15f21343ab126`
- **Base Bundle REA Evidence ID**: `ev_b6bd325b4f0cfcf161221782c31d8f9d601e14783e56be41e6b3f042c7c02eb2`

### Artifact SHA-256 Digests

| Artifact | Source URL / Origin | Size | SHA-256 |
|---|---|---|---|
| `index.html` | `https://research.google/deepreview/` | 59,011 B | `d209f679e8a578c31615a590b393d64582f0d35d5f09844162970cf0bdffa72d` |
| `discovery_v1.json` | `https://deepreview.googleapis.com/$discovery/rest?version=v1` (rev `20261030`) | 40,295 B | `0b891af662a557f6fa01eb01b9f720369c83097fab44fe00e4e53ae2fdc229eb` |
| `deepreview_bundle.js` | `/_/BoqAngularDeepReviewUi/.../dg=0/rs=.../m=_b` | 358,521 B | `bca7c3d41202f6a9d4122ad5a5ec8f1b680cbcedc868a4eb81f3681127fb641d` |
| `module_GuMH2c.js` | Lazy module `GuMH2c` (API client, configurator, papers table) | 528,159 B | `1de3f60f855510f31beba3aa0798451f5857bb5b86dfe383a3ab5f6da91beae3` |
| `module_ZZg41c.js` | Lazy module `ZZg41c` (Review viewer, PDF bbox engine, `R$` fixture) | 1,354,678 B | `5654445c76b13a531892f51c8247761ea9ee0d4a495bf5661b9b1a25e9e34bcb` |
| `newton_third_law_fixture.pdf` | Extracted from base64 constant `iAa` in `module_ZZg41c.js` | 319,081 B | `d361cff7079dfa3e8fe1a319c2929cc5b9f6f0307e40e40bbc24f2a5952547a3` |
| `google_deepreview_fixture.json` | Extracted from raw PAT constant `R$` in `module_ZZg41c.js` | 29,486 B | `7cc3b74be0707330c7e214e7ab333111168e68c51266895aa5f25f22b59dbb8e` |

---

## 2. Provenance Classification

Every component in `open-deepreview` is explicitly classified into one of three provenance categories:

### 2.1 Observed Directly in Target Binary / Bundles / Discovery Document
1. **Google Deep Review REST API v1 (`discovery_v1.json` & `module_GuMH2c.js` lines 578–596)**:
   - Service root: `https://deepreview.googleapis.com/`
   - Endpoints:
     - `POST /upload/v1/documents` (`X-Goog-Upload-Protocol: raw`, `X-Goog-Upload-File-Name`, `X-Goog-Upload-Header-Content-Type`)
     - `GET /v1/documents`, `GET /v1/{name=documents/*}`, `DELETE /v1/{name=documents/*}`, `GET /v1/{name=documents/*}:download`
     - `POST /v1/{name=documents/*}:estimateReviewCost` returning `EstimateReviewCostResponse` (`lowCost`, `medianCost`, `highCost` as `Money`, `pastReviewCount`)
     - `POST /v1/{parent=documents/*}/reviews` returning long-running `Operation` (`operations/documents/{doc}/reviews/{rev}`)
     - `GET /v1/{parent=documents/*}/reviews`, `GET /v1/{name=documents/*/reviews/*}`
     - `GET /v1/{name=userQuota}` (`maxReviewCountPerWeek`, `usedReviewCount`, `remainingReviewCount`, `customLimitEnabled`, `nextAvailableTime`)
2. **Exact Resource & Configuration Schemas (`discovery_v1.json` + `R$` in `module_ZZg41c.js` line 1319)**:
   - `DeepReviewRunConfig`: `model`, `geminiApiKey`, `geminiApiKeySet`, `thinkingLevel` (`THINKING_LEVEL_LOW` | `THINKING_LEVEL_MEDIUM` | `THINKING_LEVEL_HIGH`), `topology` (`LOW` | `MID` | `HIGH` | `EXTRA_HIGH`), `userPrompt`
   - Internal `pat_run_config` (`R$`):
     - `modules.pat`: `{ enabled, topology: 1..4, enable_search, include_segment_summaries, enforce_category_limits, segment_model_overrides }`
     - `modules.scholar_peer`: `{ enabled }`
     - `modules.citation_checker`: `{ enabled }`
     - `base_model_config.vertex.model_name`: `"gemini-3.1-pro-preview"`
   - `AnchoredReviewComment`: `commentId`, `severity` (`CRITICAL` | `MAJOR` | `MINOR` | `SUGGESTION` | `SEVERITY_UNSPECIFIED`), `summary`, `bodyMarkdown`, `suggestedEdit`, `location` (`pdf` with 1-indexed `pageNumber`, `boundingBoxes` in `[0, 1]`, `quoteSelector` `{exact, prefix, suffix}`; or `text` with `firstLine`, `lastLine`, `firstColumn`, `lastColumn`, `quotedLinePreview`), `citationReport`
   - `CitationReport`: `refNum`, `rawReference`, `citationKey`, `entryType`, `extractedMetadata`, `retrievedMetadata`, `retrievedBibtex`, `searchMethod` (`"doi"` | `"title"` | `"title_author"` | `"autocomplete"` | `""`), `firstAuthorFamilyNameMatch`, `fieldComparisons`, `lookupVerdict`, `searchVerdict`, `searchRationale`, `groundingUrls`, `finalVerdict` (`OK`, `MINOR_MISMATCH`, `MAJOR_MISMATCH`, `VERIFIED_BY_SEARCH`, `NOT_FOUND`, `HALLUCINATED`, `SKIPPED`)
3. **Client-Side Algorithms (`module_GuMH2c.js` & `module_ZZg41c.js`)**:
   - `jAa` (`module_ZZg41c.js:1319–1323`): Raw PAT fixture normalizer and numeric severity mapping (`1 -> CRITICAL`, `2 -> MAJOR`, `3 -> MINOR`, `4 -> SUGGESTION`).
   - `bta` & `NN` (`module_ZZg41c.js:1309–1314`): PDF quote-to-bounding-box matcher (NFKD normalization, hyphen/whitespace stripping, `< 0.085 * pageWidth` left-margin line-number filter, 28-char head / 24-char tail fallback anchor match, and `< 0.009` vertical line merge).
   - `ata` (`module_ZZg41c.js:1308`): Normalized `[0, 1]` bounding box to CSS percentage converter (`min-width: 2%`, `min-height: 1.4%`).
   - `Ksa`, `Osa`, `Psa`, `BN`, `EN`, `Np` (`module_ZZg41c.js:1291–1338`): Comment sorting, section summary detection, category filter chip aggregation, location badge formatting, and high-level summary slicing.
   - `NK` (`module_GuMH2c.js:618–620`): PDF upload validator (`%PDF-` header, 20 MB limit, and lexical stripper that removes comments, parenthesized literals, and streams before testing `/\/Encrypt(?:\s+\d+\s+\d+\s+R\b|\s*<<)/`).

### 2.2 Inferred from Companion Paper (`arXiv:2606.28277`) & Observed Output Structure
1. **Four-Stage PAT Multi-Agent Architecture**:
   - **Stage 1 (Document Segmentation)**: Partitioning the manuscript into overlapping thematic page segments (`segments` with `title`, `pages`, `theme`, `complexity`, `focus`).
   - **Stage 2 (Adaptive Budgeting)**: Routing segments into `LIGHT`, `MEDIUM`, or `HIGH` compute tracks that scale the number of parallel verifier passes (`passesForSegment`).
   - **Stage 3 (Deep Review & Per-Segment Consolidation)**: Running independent temperature-varied verification passes per segment followed by skeptical consolidation that drops unsupported accusations.
   - **Stage 4 (Global Synthesis & Search Grounding)**: Cross-segment de-duplication, severity calibration, category limit enforcement (`enforce_category_limits`), and reference verification against OpenAlex, Crossref, and search grounding.
2. **Markdown Output Hierarchy**:
   - `# HIGH LEVEL SUMMARY` (`## Summary`, `## Strengths`, `## Weaknesses`)
   - `## Potential Issues And Suggestions` (`### [Segment Title] (Pages: X-Y)`, `#### Potential Mistakes and Improvements`, `#### Minor Corrections and Typos`)
   - `# CITATION & REFERENCE VERIFICATION`

### 2.3 Original Design Choices (User-Requested Extensions)
1. **Universal LLM Client (`src/llm/client.ts`)**: Because Google's backend executes inside Vertex AI (`gemini-3.1-pro-preview`), the server-side model router is not shipped in the browser bundle. Per user instructions, `open-deepreview` implements a universal client accepting any `--base-url`, `--api-key`, and `--model` across OpenAI-compatible (`/chat/completions`), native Google Gemini (`:generateContent`), and native Anthropic (`/v1/messages`) protocols.
2. **Agent System Prompts (`src/agents/prompts.ts`)**: Google's server-side prompt strings are not shipped in client bundles. The prompts in `src/agents/prompts.ts` are original designs engineered to produce the exact schema and report structure observed in `R$` and `discovery_v1.json`.

---

## 3. Reconstruction Gate Ledger

| Target Behavior | Target Reference | Reconstruction Implementation | Verification Test (`tests/deepreview.test.ts`) | Status |
|---|---|---|---|---|
| Raw PAT fixture normalization & severity map | `jAa`, `fAa` (`module_ZZg41c.js:1319–1323`) | `normalizeRawPatFixture` (`src/doc/target_algorithms.ts`) | Tested on embedded `R$` fixture + novel synthetic fixture with `severity: 4` and text locations | PASS |
| PDF quote-to-bbox normalization & margin filter | `bta`, `NN` (`module_ZZg41c.js:1309–1314`) | `computeQuoteBoundingBoxesOnPage` (`src/doc/target_algorithms.ts`) | Tested on real `newton_third_law_fixture.pdf` page 1 + synthetic multi-line hyphenated items with margin line numbers | PASS |
| BBox to CSS percentage conversion | `ata` (`module_ZZg41c.js:1308`) | `getPageHighlightRects` (`src/doc/target_algorithms.ts`) | Tested on sub-threshold bounding boxes verifying `2%` min-width and `1.4%` min-height clamping | PASS |
| Comment sorting, section summary, filter chips | `Ksa`, `Osa`, `BN`, `Np` (`module_ZZg41c.js:1291–1338`) | `sortAnchoredComments`, `computeCategoryFilterChips`, `isSectionSummaryComment`, `extractHighLevelSummaryMarkdown` | Tested on multi-severity unsorted comment arrays and multi-section Markdown | PASS |
| PDF validation & `/Encrypt` lexical stripper | `NK` (`module_GuMH2c.js:618–620`) | `validatePdfBuffer` (`src/doc/target_algorithms.ts`) | Tested on PDFs with `/Encrypt` inside comments/strings vs. actual `/Encrypt 9 0 R` trailer | PASS |
| UTF-8 BOM & CRLF line splitting | `Zsa`, `$sa` (`module_ZZg41c.js:1307–1308`) | `splitTextToLines` (`src/doc/parser.ts`) | Tested on `\ufeff` BOM + mixed `\r\n` and `\r` line endings | PASS |
| Scholarly citation verification & verdict derivation | `CitationReport` (`discovery_v1.json`) | `compareFields`, `deriveLookupVerdict`, `formatBibtex`, `verifyReference` (`src/citation/checker.ts`) | Tested on exact match (`OK`), 1-year diff (`MINOR_MISMATCH`), author mismatch (`MAJOR_MISMATCH`), and `SKIPPED` | PASS |
| Custom `baseUrl`, `apiKey`, `model` + 4-stage PAT pipeline + REST API v1 | `DeepReviewRunConfig`, `discovery_v1.json`, `arXiv:2606.28277` | `UniversalLLMClient`, `DeepReviewPipeline`, `DeepReviewServer` | Tested end-to-end against local mock LLM server verifying custom `baseUrl`, `Bearer` token, `model`, anchored comments, and `/v1/*` routes | PASS |
