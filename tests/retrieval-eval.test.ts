import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  calculateConfusionMetrics,
  evaluateCase,
  evaluateLexicalThresholds,
  evaluateStrategies,
  summarizeLexicalOverlapDistributions,
  summarizeObservations,
  validateFixtureCases,
  type EvalCase,
} from "../scripts/retrieval-eval.ts";
import type { RetrievalResult } from "../supabase/functions/_shared/retrieval.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixtureCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    question: "Como se registra el control de asistencia?",
    expected: {
      documentTitle: "Módulo 11: Calificación",
      area: "Académica",
      sectionContains: "Control de asistencias",
      shouldHaveEvidence: true,
    },
    ...overrides,
  };
}

function result(overrides: Partial<RetrievalResult> = {}): RetrievalResult {
  return {
    internal: {
      chunkId: "chunk-1",
      documentId: "document-1",
      source: "notion",
      sourceId: "page-1",
      accessScope: "default",
    },
    document: {
      title: "Módulo 11: Calificación",
      sourceUrl: "https://notion.local/page-1",
      brand: "Class Limitless",
      area: "Académica",
    },
    sectionPath: "Módulo 11: Calificación > Calificar estudiantes > Control de asistencias",
    content: "En esta pestaña se lleva el registro de asistencia de cada estudiante.",
    diagnostics: {
      rank: 1,
      fusedScore: 0.04,
      vectorRank: 1,
      textRank: 1,
    },
    ...overrides,
  };
}

describe("retrieval benchmark fixture validation", () => {
  it("validates the Phase 8/9 fixture and negative classification counts", () => {
    const text = readFileSync(join(root, "fixtures/retrieval_eval_phase8.json"), "utf8");
    const cases = validateFixtureCases(JSON.parse(text));

    expect(cases).toHaveLength(52);
    expect(cases.filter((testCase) => testCase.expected.shouldHaveEvidence)).toHaveLength(24);
    expect(
      cases.filter(
        (testCase) =>
          !testCase.expected.shouldHaveEvidence && testCase.expected.nearNegative !== true,
      ),
    ).toHaveLength(12);
    expect(
      cases.filter(
        (testCase) =>
          !testCase.expected.shouldHaveEvidence && testCase.expected.nearNegative === true,
      ),
    ).toHaveLength(16);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(cases.length);
  });

  it("rejects malformed positive cases without expected document metadata", () => {
    expect(() =>
      validateFixtureCases([
        {
          id: "bad",
          question: "Que hago?",
          expected: {
            documentTitle: null,
            area: "Académica",
            sectionContains: "Matrícula",
            shouldHaveEvidence: true,
          },
        },
      ]),
    ).toThrow(/Positive fixture case/);
  });

  it("requires near-negative metadata for near-negative fixture cases", () => {
    expect(() =>
      validateFixtureCases([
        {
          id: "near-bad",
          question: "Cual es el plazo exacto?",
          expected: {
            documentTitle: null,
            area: "Académica",
            sectionContains: null,
            shouldHaveEvidence: false,
            nearNegative: true,
          },
        },
      ]),
    ).toThrow(/Near-negative fixture case/);
  });
});

describe("retrieval benchmark metrics", () => {
  it("calculates top-1, top-3, top-k, and section metrics", () => {
    const observation = evaluateCase(fixtureCase(), [
      result({
        document: { title: "Módulo 10: Matrícula", area: "Académica" },
        sectionPath: "Módulo 10: Matrícula",
        diagnostics: { rank: 1, fusedScore: 0.05, vectorRank: 1, textRank: null },
      }),
      result({
        internal: {
          chunkId: "chunk-2",
          documentId: "document-2",
          source: "notion",
          sourceId: "page-2",
          accessScope: "default",
        },
        diagnostics: { rank: 2, fusedScore: 0.04, vectorRank: 2, textRank: 1 },
      }),
    ]);

    expect(observation.expectedDocumentRank).toBe(2);
    expect(observation.expectedSectionRank).toBe(2);
    expect(observation.expectedDocumentTop1).toBe(false);
    expect(observation.expectedDocumentTop3).toBe(true);
    expect(observation.expectedDocumentTopK).toBe(true);
    expect(observation.expectedSectionTop1).toBe(false);
    expect(observation.expectedSectionTopK).toBe(true);
  });

  it("reports top-1 section accuracy separately from section hit within top-k", () => {
    const observations = [
      evaluateCase(fixtureCase({ id: "hit-top1" }), [result()]),
      evaluateCase(fixtureCase({ id: "hit-top2" }), [
        result({
          document: { title: "Módulo 11: Calificación", area: "Académica" },
          sectionPath: "Módulo 11: Calificación > Calificar estudiantes",
          diagnostics: { rank: 1, fusedScore: 0.05, vectorRank: 1, textRank: null },
        }),
        result({
          internal: {
            chunkId: "chunk-2",
            documentId: "document-1",
            source: "notion",
            sourceId: "page-1",
            accessScope: "default",
          },
          diagnostics: { rank: 2, fusedScore: 0.04, vectorRank: 2, textRank: 1 },
        }),
      ]),
    ];

    const summary = summarizeObservations(observations);

    expect(summary.positiveTop1SectionAccuracy).toBe(0.5);
    expect(summary.positiveSectionHitRate).toBe(1);
  });

  it("calculates negative zero-evidence and irrelevant-evidence rates", () => {
    const negative = fixtureCase({
      id: "negative",
      expected: {
        documentTitle: null,
        area: null,
        sectionContains: null,
        shouldHaveEvidence: false,
      },
    });
    const observations = [
      evaluateCase(negative, []),
      evaluateCase({ ...negative, id: "negative-with-results" }, [result()]),
    ];

    const summary = summarizeObservations(observations);

    expect(summary.negativeZeroEvidenceRate).toBe(0.5);
    expect(summary.negativeIrrelevantEvidenceRate).toBe(0.5);
  });

  it("separates far-negative and near-negative summary metrics", () => {
    const farNegative = fixtureCase({
      id: "far-negative",
      expected: {
        documentTitle: null,
        area: null,
        sectionContains: null,
        shouldHaveEvidence: false,
      },
    });
    const nearNegative = fixtureCase({
      id: "near-negative",
      expected: {
        documentTitle: null,
        area: "Académica",
        sectionContains: null,
        shouldHaveEvidence: false,
        nearNegative: true,
        relatedDocumentTitle: "Módulo 11: Calificación",
        unsupportedRationale: "No exact deadline is documented.",
      },
    });

    const summary = summarizeObservations([
      evaluateCase(farNegative, []),
      evaluateCase(nearNegative, [result()]),
    ]);

    expect(summary.farNegativeCases).toBe(1);
    expect(summary.nearNegativeCases).toBe(1);
    expect(summary.farNegativeZeroEvidenceRate).toBe(1);
    expect(summary.nearNegativeIrrelevantEvidenceRate).toBe(1);
  });

  it("summarizes lexical-overlap distributions", () => {
    const observations = [
      evaluateCase(fixtureCase({ id: "positive" }), [result()]),
      evaluateCase(
        fixtureCase({
          id: "far",
          question: "Politica de vacaciones",
          expected: {
            documentTitle: null,
            area: null,
            sectionContains: null,
            shouldHaveEvidence: false,
          },
        }),
        [result({ content: "Contenido sobre asistencia academica." })],
      ),
      evaluateCase(
        fixtureCase({
          id: "near",
          question: "Cuantos dias tiene el control de asistencia?",
          expected: {
            documentTitle: null,
            area: "Académica",
            sectionContains: null,
            shouldHaveEvidence: false,
            nearNegative: true,
            relatedDocumentTitle: "Módulo 11: Calificación",
            unsupportedRationale: "No exact days are documented.",
          },
        }),
        [result()],
      ),
    ];

    const distributions = summarizeLexicalOverlapDistributions(observations);

    expect(distributions.positiveMaxOverlap.max).toBeGreaterThan(0);
    expect(distributions.farNegativeMaxOverlap.max).toBe(0);
    expect(distributions.nearNegativeMaxOverlap.max).toBeGreaterThan(0);
  });
});

describe("retrieval sufficiency strategy evaluation", () => {
  it("calculates confusion-matrix metrics", () => {
    const positive = evaluateCase(fixtureCase({ id: "positive" }), [result()]);
    const negative = evaluateCase(
      fixtureCase({
        id: "negative",
        expected: {
          documentTitle: null,
          area: null,
          sectionContains: null,
          shouldHaveEvidence: false,
        },
      }),
      [],
    );

    const metrics = calculateConfusionMetrics([
      {
        observation: positive,
        decision: {
          strategyId: "strategy0_any_retrieval",
          label: "test",
          sufficient: true,
          reason: "positive accepted",
        },
      },
      {
        observation: negative,
        decision: {
          strategyId: "strategy0_any_retrieval",
          label: "test",
          sufficient: false,
          reason: "negative rejected",
        },
      },
    ]);

    expect(metrics).toMatchObject({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 1,
      falseNegative: 0,
      precision: 1,
      recall: 1,
      specificity: 1,
      accuracy: 1,
    });
  });

  it("evaluates deterministic strategies without mutating retrieval observations", () => {
    const positive = evaluateCase(fixtureCase({ id: "positive" }), [result()]);
    const negative = evaluateCase(
      fixtureCase({
        id: "negative",
        question: "Cual es la politica de vacaciones?",
        expected: {
          documentTitle: null,
          area: null,
          sectionContains: null,
          shouldHaveEvidence: false,
        },
      }),
      [
        result({
          document: { title: "Módulo 3. Seguridad", area: "Seguridad" },
          sectionPath: "Módulo 3. Seguridad",
          content: "Políticas contraseña solicitud contraseña seguridad portales.",
          diagnostics: { rank: 1, fusedScore: 0.02, vectorRank: 1, textRank: null },
        }),
      ],
    );

    const comparison = evaluateStrategies([positive, negative]);

    expect(comparison.map((strategy) => strategy.strategyId)).toEqual([
      "strategy0_any_retrieval",
      "strategy1_vector_lexical_agreement",
      "strategy2_lexical_coverage",
      "strategy3_rank_separation_proxy",
      "strategy4_combined_deterministic",
    ]);
    expect(comparison[0].metrics.falsePositive).toBe(1);
    expect(comparison[1].metrics.trueNegative).toBe(1);
  });

  it("tracks positive cases rejected and negative cases accepted by strategy", () => {
    const rejectedPositive = evaluateCase(fixtureCase({ id: "positive-rejected" }), []);
    const acceptedNegative = evaluateCase(
      fixtureCase({
        id: "negative-accepted",
        expected: {
          documentTitle: null,
          area: null,
          sectionContains: null,
          shouldHaveEvidence: false,
        },
      }),
      [result()],
    );

    const metrics = calculateConfusionMetrics([
      {
        observation: rejectedPositive,
        decision: {
          strategyId: "strategy0_any_retrieval",
          label: "test",
          sufficient: false,
          reason: "empty",
        },
      },
      {
        observation: acceptedNegative,
        decision: {
          strategyId: "strategy0_any_retrieval",
          label: "test",
          sufficient: true,
          reason: "nonempty",
        },
      },
    ]);

    expect(metrics.rejectedPositiveCaseIds).toEqual(["positive-rejected"]);
    expect(metrics.acceptedNegativeCaseIds).toEqual(["negative-accepted"]);
    expect(metrics.recall).toBe(0);
    expect(metrics.specificity).toBe(0);
    expect(metrics.farNegativeFalsePositiveRate).toBe(1);
    expect(metrics.nearNegativeFalsePositiveRate).toBe(0);
  });

  it("tracks near-negative false-positive rates separately", () => {
    const acceptedNearNegative = evaluateCase(
      fixtureCase({
        id: "near-negative-accepted",
        expected: {
          documentTitle: null,
          area: "Académica",
          sectionContains: null,
          shouldHaveEvidence: false,
          nearNegative: true,
          relatedDocumentTitle: "Módulo 11: Calificación",
          unsupportedRationale: "No exact limit is documented.",
        },
      }),
      [result()],
    );

    const metrics = calculateConfusionMetrics([
      {
        observation: acceptedNearNegative,
        decision: {
          strategyId: "strategy0_any_retrieval",
          label: "test",
          sufficient: true,
          reason: "nonempty",
        },
      },
    ]);

    expect(metrics.nearNegativeFalsePositiveRate).toBe(1);
    expect(metrics.acceptedNearNegativeCaseIds).toEqual(["near-negative-accepted"]);
  });

  it("evaluates lexical threshold sweep metrics", () => {
    const positive = evaluateCase(fixtureCase({ id: "positive" }), [result()]);
    const farNegative = evaluateCase(
      fixtureCase({
        id: "far-negative",
        question: "Politica de vacaciones",
        expected: {
          documentTitle: null,
          area: null,
          sectionContains: null,
          shouldHaveEvidence: false,
        },
      }),
      [result({ content: "Contenido sobre asistencia academica." })],
    );
    const nearNegative = evaluateCase(
      fixtureCase({
        id: "near-negative",
        question: "Cuantos dias tiene el control de asistencia?",
        expected: {
          documentTitle: null,
          area: "Académica",
          sectionContains: null,
          shouldHaveEvidence: false,
          nearNegative: true,
          relatedDocumentTitle: "Módulo 11: Calificación",
          unsupportedRationale: "No exact days are documented.",
        },
      }),
      [result()],
    );

    const sweep = evaluateLexicalThresholds([positive, farNegative, nearNegative], [0.1, 0.9]);

    expect(sweep[0]).toMatchObject({
      threshold: 0.1,
      positiveRecall: 1,
      farNegativeSpecificity: 1,
      nearNegativeSpecificity: 0,
      falsePositive: 1,
    });
    expect(sweep[1].falseNegative).toBeGreaterThan(0);
  });
});
