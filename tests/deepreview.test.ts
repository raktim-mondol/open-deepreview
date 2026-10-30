import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorQuote, locateQuoteInText } from "../src/agents/anchoring.ts";
import {
  DeepReviewPipeline,
  estimateReviewCost,
  passesForSegment,
} from "../src/agents/pipeline.ts";
import {
  compareFields,
  deriveLookupVerdict,
  formatBibtex,
  makeCitationKey,
  titlesMatch,
  verifyReference,
} from "../src/citation/checker.ts";
import { resolveConfig } from "../src/config/store.ts";
import { parseManuscriptFile, splitTextToLines } from "../src/doc/parser.ts";
import {
  computeCategoryFilterChips,
  computeQuoteBoundingBoxesOnPage,
  extractHighLevelSummaryMarkdown,
  formatCommentLocationBadge,
  getCommentCategory,
  getCommentCleanBody,
  getCommentSuggestedAction,
  getPageHighlightRects,
  isSectionSummaryComment,
  normalizeRawPatFixture,
  sortAnchoredComments,
  validatePdfBuffer,
} from "../src/doc/target_algorithms.ts";
import { UniversalLLMClient } from "../src/llm/client.ts";
import type { AnchoredReviewComment, RawPatFixture } from "../src/types/schema.ts";
import { DeepReviewServer } from "../src/ui/viewer_server.ts";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

describe("Reconstructed Target Algorithms (Google Deep Review JS bundle)", () => {
  test("jAa: normalizeRawPatFixture normalizes embedded R$ fixture and maps numeric severities", () => {
    const raw = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "google_deepreview_fixture.json"), "utf8")
    ) as RawPatFixture;
    const { document, review } = normalizeRawPatFixture(raw);

    expect(document.name).toBe("documents/paper-review-fixture");
    expect(document.displayName).toBe("Newton_s third law of motion .pdf!");
    expect(review.state).toBe("SUCCEEDED");
    expect(review.runConfig?.model).toBe("gemini-3.1-pro-preview");
    expect(review.runConfig?.topology).toBe("MID");

    const comments = review.result?.anchoredComments ?? [];
    expect(comments.length).toBe(15);

    const severities = new Set(comments.map((c) => c.severity));
    expect(severities.has("CRITICAL")).toBe(true);
    expect(severities.has("MAJOR")).toBe(true);
    expect(severities.has("MINOR")).toBe(true);

    // Changed input test: custom raw fixture with severity 4 (SUGGESTION) and text location
    const customRaw: RawPatFixture = {
      ...raw,
      paper_id: "custom-paper-99",
      filename: "custom_theory.tex",
      pat_topology: 4,
      anchored_comments: [
        {
          comment_id: "c-custom-1",
          severity: 4,
          summary: "Notation suggestion",
          body_markdown: "Consider clearer notation.\n\n**Suggested Action:** Replace x with y.",
          suggested_edit: "",
          location: {
            text: {
              first_line: 12,
              last_line: 15,
              first_column: 1,
              last_column: 20,
              quoted_line_preview: "\\forall x \\in X",
            },
          },
        },
      ],
    };
    const normCustom = normalizeRawPatFixture(customRaw);
    expect(normCustom.document.name).toBe("documents/custom-paper-99");
    expect(normCustom.review.runConfig?.topology).toBe("EXTRA_HIGH");
    expect(normCustom.review.result?.anchoredComments?.[0]?.severity).toBe("SUGGESTION");
    expect(
      formatCommentLocationBadge(normCustom.review.result!.anchoredComments![0])
    ).toBe("Lines 12\u201315");
    expect(
      getCommentSuggestedAction(normCustom.review.result!.anchoredComments![0])
    ).toBe("Replace x with y.");
    expect(
      getCommentCleanBody(normCustom.review.result!.anchoredComments![0])
    ).toBe("Consider clearer notation.");
  });

  test("bta & ata: PDF parsing + quote-to-bounding-box matching + CSS highlight conversion on real fixture PDF and novel synthetic inputs", async () => {
    const pdfPath = join(FIXTURES_DIR, "newton_third_law_fixture.pdf");
    const parsed = await parseManuscriptFile(pdfPath);
    expect(parsed.format).toBe("pdf");
    expect(parsed.pages.length).toBeGreaterThanOrEqual(4);

    const page1Layer = parsed.pages[0].pdfTextLayer!;
    expect(page1Layer.items.length).toBeGreaterThan(20);

    // Match the first anchored quote from page 1 of the Newton's Third Law fixture
    const boxes = computeQuoteBoundingBoxesOnPage(
      "Newton’s third law of motion tells us that forces always occur in pairs",
      page1Layer.items,
      page1Layer.width,
      page1Layer.height
    );
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes[0].left).toBeGreaterThanOrEqual(0);
    expect(boxes[0].right).toBeLessThanOrEqual(1);

    // Changed input test: synthetic PDF text layer with left-margin line numbers (< 0.085 * width) and hyphenated line wrap
    const syntheticItems = [
      { str: "042", transform: [10, 0, 0, 10, 20, 700], width: 15 }, // left margin line number (20/612 = 0.032 < 0.085) -> must be skipped!
      { str: "We prove that counter-", transform: [10, 0, 0, 10, 100, 700], width: 120 },
      { str: "examples exist for all n >= 2.", transform: [10, 0, 0, 10, 100, 685], width: 150 },
    ];
    const synthBoxes = computeQuoteBoundingBoxesOnPage(
      "We prove that counterexamples exist for all n >= 2.",
      syntheticItems,
      612,
      792
    );
    // Should span 2 lines and ignore the "042" margin number
    expect(synthBoxes.length).toBe(2);
    expect(synthBoxes[0].top).toBeLessThan(synthBoxes[1].top);

    // Test `ata` CSS highlight percentage conversion with min width 2% and min height 1.4%
    const tinyComment: AnchoredReviewComment = {
      commentId: "c-tiny",
      severity: "CRITICAL",
      summary: "Tiny box",
      bodyMarkdown: "Body",
      location: {
        pdf: {
          pageNumber: 1,
          boundingBoxes: [{ left: 0.5, top: 0.5, right: 0.501, bottom: 0.501 }],
        },
      },
    };
    const rects = getPageHighlightRects(1, [tinyComment]);
    expect(rects.length).toBe(1);
    expect(rects[0].widthPct).toBe(2);
    expect(rects[0].heightPct).toBe(1.4);
  });

  test("Ksa, Osa, BN, Np: comment sorting, section summary detection, category filter chips, and summary extraction", () => {
    const comments: AnchoredReviewComment[] = [
      {
        commentId: "c-late-page1",
        severity: "MINOR",
        summary: "Bottom of page 1",
        bodyMarkdown: "Issue at bottom",
        location: {
          pdf: {
            pageNumber: 1,
            boundingBoxes: [{ left: 0.2, top: 0.8, right: 0.5, bottom: 0.82 }],
          },
        },
      },
      {
        commentId: "section-1",
        severity: "SEVERITY_UNSPECIFIED",
        summary: "Introduction Summary",
        bodyMarkdown: "Section summary card",
        location: { pdf: { pageNumber: 1 } },
      },
      {
        commentId: "c-early-page1",
        severity: "CRITICAL",
        summary: "Top of page 1",
        bodyMarkdown: "Issue at top",
        location: {
          pdf: {
            pageNumber: 1,
            boundingBoxes: [{ left: 0.1, top: 0.2, right: 0.4, bottom: 0.22 }],
          },
        },
      },
    ];

    expect(isSectionSummaryComment(comments[1])).toBe(true);
    expect(isSectionSummaryComment(comments[2])).toBe(false);

    const sorted = sortAnchoredComments(comments);
    // Section summary on page 1 comes first, then top bbox (0.2), then bottom bbox (0.8)
    expect(sorted.map((c) => c.commentId)).toEqual([
      "section-1",
      "c-early-page1",
      "c-late-page1",
    ]);

    const chips = computeCategoryFilterChips(sorted);
    expect(chips.find((c) => c.key === "ALL")?.count).toBe(3);
    expect(chips.find((c) => c.key === "SECTION_SUMMARY")?.count).toBe(1);
    expect(chips.find((c) => c.key === "CRITICAL")?.count).toBe(1);
    expect(chips.find((c) => c.key === "MINOR")?.count).toBe(1);

    const md = `# HIGH LEVEL SUMMARY\n---\n## Summary\nGreat paper.\n\n## Potential Issues And Suggestions\n### Segment 1`;
    expect(extractHighLevelSummaryMarkdown(md)).toBe("## Summary\nGreat paper.");
  });

  test("NK: validatePdfBuffer distinguishes real /Encrypt dictionaries from /Encrypt inside comments or string literals", () => {
    const validWithCommentAndString = new TextEncoder().encode(
      `%PDF-1.7\n% Comment mentioning /Encrypt 12 0 R\n1 0 obj\n<< /Title (A paper about /Encrypt << /V 2 >> in PDFs) >>\nendobj\n%%EOF`
    );
    expect(validatePdfBuffer(validWithCommentAndString)).toEqual({ valid: true });

    const realEncrypted = new TextEncoder().encode(
      `%PDF-1.7\n1 0 obj\n<< /Root 2 0 R /Encrypt 9 0 R >>\nendobj\n%%EOF`
    );
    const res = validatePdfBuffer(realEncrypted);
    expect(res.valid).toBe(false);
    expect(res.error).toContain("password-protected or encrypted");

    const nonPdf = new TextEncoder().encode(`Hello world`);
    expect(validatePdfBuffer(nonPdf).valid).toBe(false);
  });

  test("Zsa/$sa: splitTextToLines handles UTF-8 BOM, CRLF, and trailing newline", () => {
    const input = "\ufeffLine 1\r\nLine 2\rLine 3\n";
    expect(splitTextToLines(input)).toEqual(["Line 1", "Line 2", "Line 3"]);
  });
});

describe("Citation Checker & Anchoring Verification", () => {
  test("Citation field comparison, BibTeX generation, and lookupVerdict derivation", async () => {
    expect(
      titlesMatch(
        "Attention Is All You Need",
        "Attention is all you need!"
      )
    ).toBe(true);

    const key = makeCitationKey({
      refNum: 1,
      rawReference: "Vaswani et al. (2017). Attention Is All You Need.",
      entryType: "inproceedings",
      title: "Attention Is All You Need",
      authors: [{ givenName: "Ashish", familyName: "Vaswani" }],
      year: 2017,
    });
    expect(key).toBe("vaswani2017attention");

    const extracted = {
      title: "Attention Is All You Need",
      authors: [{ givenName: "Ashish", familyName: "Vaswani" }],
      publicationDate: { year: 2017, month: 0, day: 0 },
      journal: "Advances in Neural Information Processing Systems",
      volume: "30",
    };

    // Exact match -> OK
    const exactComp = compareFields(extracted, { ...extracted, source: "openalex" });
    expect(deriveLookupVerdict(exactComp.comparisons)).toBe("OK");

    // Year off by 1 -> MINOR_MISMATCH
    const minorComp = compareFields(extracted, {
      ...extracted,
      publicationDate: { year: 2018, month: 0, day: 0 },
    });
    expect(deriveLookupVerdict(minorComp.comparisons)).toBe("MINOR_MISMATCH");

    // Author mismatch -> MAJOR_MISMATCH
    const majorComp = compareFields(extracted, {
      ...extracted,
      authors: [{ givenName: "John", familyName: "Smith" }],
    });
    expect(deriveLookupVerdict(majorComp.comparisons)).toBe("MAJOR_MISMATCH");

    const bib = formatBibtex(key, "inproceedings", extracted);
    expect(bib).toContain("@inproceedings{vaswani2017attention,");
    expect(bib).toContain("booktitle = {Advances in Neural Information Processing Systems}");

    // Non-paper skipped
    const skipped = await verifyReference(
      null,
      {
        refNum: 2,
        rawReference: "PyTorch repository https://pytorch.org",
        entryType: "misc",
        isNonPaper: true,
      },
      { enableSearchGrounding: false, offline: true }
    );
    expect(skipped.finalVerdict).toBe("SKIPPED");
  });

  test("locateQuoteInText and anchorQuote produce W3C TextQuoteSelector and line spans", async () => {
    const sample = "First line of the proof.\nLet f(x) = x^2 + 2x + 1 be a convex quadratic function.\nThird line.";
    const hit = locateQuoteInText(sample, "f(x) = x^2 + 2x + 1 be a convex");
    expect(hit).not.toBeNull();
    expect(hit?.exact).toBe("f(x) = x^2 + 2x + 1 be a convex");
    expect(hit?.prefix).toContain("First line");

    const lines = splitTextToLines(sample);
    const loc = anchorQuote(
      {
        filename: "sample.tex",
        format: "latex",
        fullText: sample,
        lines,
        pages: [{ pageNumber: 1, text: sample, lines }],
        rawBytes: new TextEncoder().encode(sample),
      },
      "f(x) = x^2 + 2x + 1"
    );
    expect(loc?.text?.firstLine).toBe(2);
    expect(loc?.text?.quotedLinePreview).toContain("f(x) = x^2 + 2x + 1");
  });
});

describe("Universal LLM Client (Custom baseUrl, apiKey, model) & Full PAT Pipeline", () => {
  test("UniversalLLMClient routes custom baseUrl, Authorization Bearer apiKey, and model, and runs full 4-stage PAT pipeline + REST API v1 server", async () => {
    const receivedRequests: Array<{ url: string; auth: string | null; model: string }> = [];

    // Spin up a local mock OpenAI-compatible LLM server
    const mockLlmServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as any;
        receivedRequests.push({
          url: new URL(req.url).pathname,
          auth: req.headers.get("authorization"),
          model: body.model,
        });
        const sys: string = body.messages?.[0]?.content ?? "";
        let reply: unknown = {};

        if (sys.includes("Segmenter agent")) {
          reply = {
            segments: [
              {
                title: "Main Theorem & Proof",
                pages: [1],
                theme: "theory",
                complexity: "HIGH",
                focus: "Check quadratic bound",
              },
            ],
          };
        } else if (sys.includes("Deep Review verification agent")) {
          reply = {
            segment_summary: "Establishes the main convexity claim.",
            issues: [
              {
                title: "Strict Inequality Error at Origin",
                summary: "Strict inequality fails at x = 0",
                category: "mistake",
                severity: "CRITICAL",
                page: 1,
                quote: "Strictly positive for all real x",
                body: "For $x = 0$, $x^2 = 0$, violating strict positivity.",
                suggested_edit: "Non-negative for all real x",
              },
            ],
          };
        } else if (sys.includes("per-segment consolidation")) {
          reply = {
            segment_summary: "Establishes the main convexity claim.",
            issues: [
              {
                title: "Strict Inequality Error at Origin",
                summary: "Strict inequality fails at x = 0",
                category: "mistake",
                severity: "CRITICAL",
                page: 1,
                quote: "Strictly positive for all real x",
                body: "For $x = 0$, $x^2 = 0$, violating strict positivity.",
                suggested_edit: "Non-negative for all real x",
              },
            ],
          };
        } else if (sys.includes("Global Synthesis agent")) {
          reply = {
            keep: [{ id: "s0-i0", severity: "CRITICAL" }],
          };
        } else if (sys.includes("Scholar Peer agent")) {
          reply = {
            summary: "The paper investigates quadratic positivity.",
            strengths: ["Clear problem formulation."],
            weaknesses: [
              {
                text: "The boundary case at the origin is overlooked.",
                severity: "MAJOR",
                summary: "Origin boundary case",
                page: 1,
                quote: "Strictly positive for all real x",
              },
            ],
          };
        } else if (sys.includes("Citation Extraction agent")) {
          reply = { references: [] };
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl-test",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(reply) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50 },
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      },
    });

    try {
      const customBaseUrl = `http://localhost:${mockLlmServer.port}/v1`;
      const customApiKey = "sk-custom-user-key-12345";
      const customModel = "custom-research-llm-v2";

      const cfg = resolveConfig({
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
        model: customModel,
        topology: "LOW",
        thinkingLevel: "THINKING_LEVEL_HIGH",
      });

      expect(passesForSegment("HIGH", 4)).toBe(4);
      expect(passesForSegment("LIGHT", 4)).toBe(2);

      const manuscriptText = "Theorem 1. The function f(x) = x^2 is Strictly positive for all real x.\nProof. Trivial.";
      const lines = splitTextToLines(manuscriptText);
      const doc = {
        filename: "theorem.md",
        format: "markdown" as const,
        fullText: manuscriptText,
        lines,
        pages: [{ pageNumber: 1, text: manuscriptText, lines }],
        rawBytes: new TextEncoder().encode(manuscriptText),
      };

      const pipeline = new DeepReviewPipeline({
        config: cfg,
        userPrompt: "Focus on boundary conditions",
        offlineCitations: true,
      });
      const review = await pipeline.run(doc);

      expect(review.state).toBe("SUCCEEDED");
      expect(review.runConfig?.model).toBe(customModel);
      expect(review.runConfig?.baseUrl).toBe(customBaseUrl);
      expect(review.result?.reviewMarkdown).toContain("# HIGH LEVEL SUMMARY");
      expect(review.result?.reviewMarkdown).toContain("Strict Inequality Error at Origin");
      expect(review.result?.anchoredComments?.length).toBeGreaterThanOrEqual(2);

      // Verify custom baseUrl, apiKey, and model were sent to the endpoint
      expect(receivedRequests.length).toBeGreaterThan(0);
      expect(receivedRequests[0].url).toBe("/v1/chat/completions");
      expect(receivedRequests[0].auth).toBe(`Bearer ${customApiKey}`);
      expect(receivedRequests[0].model).toBe(customModel);

      // Verify cost estimation endpoint logic
      const cost = estimateReviewCost(doc, { model: customModel, topology: "HIGH" });
      expect(cost.medianCost?.currencyCode).toBe("USD");

      // Verify DeepReviewServer REST API v1 endpoints
      const apiServer = new DeepReviewServer();
      const quotaRes = await apiServer.handleRequest(new Request("http://localhost/v1/userQuota"));
      expect(quotaRes.status).toBe(200);
      const quotaJson = (await quotaRes.json()) as any;
      expect(quotaJson.name).toBe("userQuota");

      const docsRes = await apiServer.handleRequest(new Request("http://localhost/v1/documents"));
      const docsJson = (await docsRes.json()) as any;
      expect(docsJson.documents.length).toBeGreaterThanOrEqual(1);
    } finally {
      mockLlmServer.stop(true);
    }
  });
});
