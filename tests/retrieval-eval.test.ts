import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DOCUMENT_REGISTRY,
  calculateConfusionMetrics,
  calculateWhatIfMetrics,
  classifyComponentComparison,
  evaluateCase,
  evaluateCompositeParameterSweep,
  evaluateCompositeStrategies,
  evaluateLexicalThresholds,
  evaluateStrategies,
  rankLexicalOnly,
  rankVectorOnly,
  summarizeCompositeSignalDistributions,
  summarizeLexicalOverlapDistributions,
  summarizeObservations,
  validateCanonicalDocumentRegistry,
  validateFixtureCases,
  type DiagnosticChunk,
  type EvalCase,
} from "../scripts/retrieval-eval.ts";
import type { RetrievalResult } from "../supabase/functions/_shared/retrieval.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

function fixtureCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: "case-1",
    question: "Como se registra el control de asistencia?",
    expected: {
      documentKey: "class-limitless-academica-calificacion",
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

function diagnosticChunk(overrides: Partial<DiagnosticChunk> = {}): DiagnosticChunk {
  return {
    documentTitle: "Módulo 11: Calificación",
    documentId: "document-1",
    sourceUrl: "https://notion.local/page-1",
    area: "Académica",
    accessScope: "default",
    sectionPath: "Módulo 11: Calificación > Control de asistencias",
    content: "registro asistencia estudiante docente",
    tokenEstimate: 60,
    ordinal: 0,
    embedding: [1, 0, 0],
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
    expect(
      cases
        .filter((testCase) => testCase.expected.shouldHaveEvidence)
        .every((testCase) => testCase.expected.documentKey && testCase.expected.documentTitle),
    ).toBe(true);
  });

  it("validates the Phase 9C paraphrase fixture separately", () => {
    const text = readFileSync(
      join(root, "fixtures/retrieval_eval_phase9c_paraphrases.json"),
      "utf8",
    );
    const cases = validateFixtureCases(JSON.parse(text), "paraphrase");

    expect(cases).toHaveLength(16);
    expect(cases.filter((testCase) => testCase.expected.shouldHaveEvidence)).toHaveLength(8);
    expect(
      cases.filter(
        (testCase) =>
          !testCase.expected.shouldHaveEvidence && testCase.expected.nearNegative === true,
      ),
    ).toHaveLength(8);
    expect(cases.every((testCase) => testCase.suite === "paraphrase")).toBe(true);
    expect(
      cases
        .filter((testCase) => testCase.expected.shouldHaveEvidence)
        .map((testCase) => testCase.expected.documentKey),
    ).toEqual([
      "class-limitless-academica-matricula",
      "class-limitless-academica-homologaciones",
      "class-limitless-academica-homologaciones",
      "class-limitless-academica-calificacion",
      "class-limitless-academica-calificacion",
      "class-limitless-seguridad",
      "class-limitless-financiera-facturacion",
      "class-limitless-configuraciones-parametros",
    ]);
  });

  it("rejects malformed positive cases without expected document metadata", () => {
    expect(() =>
      validateFixtureCases([
        {
          id: "bad",
          question: "Que hago?",
          expected: {
            documentKey: null,
            area: "Académica",
            sectionContains: "Matrícula",
            shouldHaveEvidence: true,
          },
        },
      ]),
    ).toThrow(/Positive fixture case/);
  });

  it("resolves documentKey to the canonical stored title", () => {
    const [testCase] = validateFixtureCases([
      {
        id: "canonical",
        question: "Como configuro faltas?",
        expected: {
          documentKey: "class-limitless-academica-homologaciones",
          area: "Académica",
          sectionContains: "Faltas de asistencia",
          shouldHaveEvidence: true,
        },
      },
    ]);

    expect(testCase?.expected.documentTitle).toBe(
      CANONICAL_DOCUMENT_REGISTRY["class-limitless-academica-homologaciones"],
    );
  });

  it("rejects legacy fixture documentTitle fields", () => {
    expect(() =>
      validateFixtureCases([
        {
          id: "legacy",
          question: "Como configuro faltas?",
          expected: {
            documentTitle: "Módulo 6: Homologaciones",
            area: "Académica",
            sectionContains: "Faltas de asistencia",
            shouldHaveEvidence: true,
          },
        },
      ]),
    ).toThrow(/documentKey instead of documentTitle/);
  });

  it("validates canonical registry uniqueness and local corpus presence", () => {
    validateCanonicalDocumentRegistry(Object.values(CANONICAL_DOCUMENT_REGISTRY));

    expect(() =>
      validateCanonicalDocumentRegistry([
        CANONICAL_DOCUMENT_REGISTRY["class-limitless-academica-matricula"],
      ]),
    ).toThrow(/missing from the local corpus/);
  });

  it("requires near-negative metadata for near-negative fixture cases", () => {
    expect(() =>
      validateFixtureCases([
        {
          id: "near-bad",
          question: "Cual es el plazo exacto?",
          expected: {
            documentKey: null,
            area: "Académica",
            sectionContains: null,
            shouldHaveEvidence: false,
            nearNegative: true,
          },
        },
      ]),
    ).toThrow(/Near-negative fixture case/);
  });

  it("allows negative cases without documentKey and near negatives with relatedDocumentKey", () => {
    const cases = validateFixtureCases([
      {
        id: "far",
        question: "Cual es la politica de vacaciones?",
        expected: {
          documentKey: null,
          area: null,
          sectionContains: null,
          shouldHaveEvidence: false,
        },
      },
      {
        id: "near",
        question: "Cuantos dias tarda una homologacion?",
        expected: {
          documentKey: null,
          area: "Académica",
          sectionContains: null,
          shouldHaveEvidence: false,
          nearNegative: true,
          relatedDocumentKey: "class-limitless-academica-homologaciones",
          unsupportedRationale: "No processing time is documented.",
        },
      },
    ]);

    expect(cases[0]?.expected.documentTitle).toBeNull();
    expect(cases[1]?.expected.relatedDocumentTitle).toBe(
      CANONICAL_DOCUMENT_REGISTRY["class-limitless-academica-homologaciones"],
    );
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

  it("scores canonical documentKey expectations against canonical stored titles", () => {
    const [testCase] = validateFixtureCases(
      [
        {
          id: "p9c-pos-002",
          question: "¿Cómo registro equivalencias de asignaturas entre programas?",
          expected: {
            documentKey: "class-limitless-academica-homologaciones",
            area: "Académica",
            sectionContains: "Homologación de cursos",
            shouldHaveEvidence: true,
          },
        },
      ],
      "paraphrase",
    );

    const observation = evaluateCase(testCase!, [
      result({
        document: {
          title:
            "Módulo 6. Homologaciones - Faltas de asistencia - Consecutivo actas de grado y diplomas",
          sourceUrl: "https://notion.local/homologaciones",
          brand: "Class Limitless",
          area: "Académica",
        },
        sectionPath:
          "Módulo 6. Homologaciones - Faltas de asistencia - Consecutivo actas de grado y diplomas > Homologación de cursos",
        content: "Homologación de cursos entre programas académicos.",
      }),
    ]);

    expect(observation.expectedDocumentRank).toBe(1);
    expect(observation.expectedSectionRank).toBe(1);
    expect(observation.expectedDocumentTop1).toBe(true);
    expect(observation.expectedSectionTop1).toBe(true);
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

  it("calculates composite concentration and token-coverage signals", () => {
    const observation = evaluateCase(
      fixtureCase({
        question: "Cuantos intentos bloquea cuenta contrasena soporte",
      }),
      [
        result({
          document: {
            title: "Módulo 3: Seguridad",
            sourceUrl: "https://notion.local/security",
            brand: "Class Limitless",
            area: "Seguridad",
          },
          sectionPath: "Módulo 3: Seguridad > Políticas de Contraseña",
          content: "La contrasena de la cuenta puede configurarse con intentos.",
          diagnostics: { rank: 1, fusedScore: 0.05, vectorRank: 1, textRank: 1 },
        }),
        result({
          internal: {
            chunkId: "chunk-2",
            documentId: "document-security",
            source: "notion",
            sourceId: "page-security",
            accessScope: "default",
          },
          document: {
            title: "Módulo 3: Seguridad",
            sourceUrl: "https://notion.local/security",
            brand: "Class Limitless",
            area: "Seguridad",
          },
          sectionPath: "Módulo 3: Seguridad > Políticas de Contraseña",
          content: "La cuenta se bloquea segun configuracion de seguridad.",
          diagnostics: { rank: 2, fusedScore: 0.04, vectorRank: 2, textRank: 2 },
        }),
        result({
          internal: {
            chunkId: "chunk-3",
            documentId: "document-security",
            source: "notion",
            sourceId: "page-security",
            accessScope: "default",
          },
          document: {
            title: "Módulo 3: Seguridad",
            sourceUrl: "https://notion.local/security",
            brand: "Class Limitless",
            area: "Seguridad",
          },
          sectionPath: "Módulo 3: Seguridad > Usuarios",
          content: "Soporte administra usuarios.",
          diagnostics: { rank: 3, fusedScore: 0.03, vectorRank: 3, textRank: null },
        }),
        result({
          internal: {
            chunkId: "chunk-4",
            documentId: "document-finance",
            source: "notion",
            sourceId: "page-finance",
            accessScope: "default",
          },
          document: {
            title: "Módulo 5: Financiera",
            sourceUrl: "https://notion.local/finance",
            brand: "Class Limitless",
            area: "Financiera",
          },
          sectionPath: "Módulo 5: Financiera > Cuotas",
          content: "Cuotas y pagos.",
          diagnostics: { rank: 4, fusedScore: 0.02, vectorRank: null, textRank: 3 },
        }),
      ],
    );

    expect(observation.signals.dominantDocument).toBe("Módulo 3: Seguridad");
    expect(observation.signals.dominantDocumentConcentration).toBe(0.75);
    expect(observation.signals.dominantSectionConcentration).toBe(0.5);
    expect(observation.signals.supportingChunkCount).toBe(2);
    expect(observation.signals.top1Top2DocumentAgreement).toBe(true);
    expect(observation.signals.queryTokenCoverage).toBeGreaterThan(0.7);
    expect(observation.signals.specificTokenCoverage).toBeGreaterThan(0.7);
  });

  it("summarizes composite signal distributions by class", () => {
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
      [],
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

    const distributions = summarizeCompositeSignalDistributions([
      positive,
      farNegative,
      nearNegative,
    ]);

    expect(distributions.positive.maxLexicalOverlap.max).toBeGreaterThan(0);
    expect(distributions.farNegative.maxLexicalOverlap.max).toBe(0);
    expect(distributions.nearNegative.queryTokenCoverage.max).toBeGreaterThan(0);
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

  it("evaluates composite strategies and parameter sweeps", () => {
    const positive = evaluateCase(fixtureCase({ id: "positive" }), [result()]);
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
      [result({ content: "Control de asistencia del estudiante." })],
    );

    const comparison = evaluateCompositeStrategies([positive, nearNegative]);
    const sweep = evaluateCompositeParameterSweep([positive, nearNegative]);

    expect(comparison.map((strategy) => strategy.strategyId)).toEqual([
      "c0_lexical_only",
      "c1_overlap_query_coverage",
      "c2_overlap_supporting_chunks",
      "c3_overlap_document_concentration",
      "c4_overlap_section_concentration",
      "c5_overlap_specific_token_coverage",
      "c6_simple_three_signal",
    ]);
    expect(sweep.length).toBeGreaterThan(comparison.length);
    expect(sweep[0].metrics.recall).toBeGreaterThanOrEqual(sweep[sweep.length - 1].metrics.recall);
  });
});

describe("retrieval component diagnostics", () => {
  it("ranks vector-only candidates by cosine similarity", () => {
    const ranking = rankVectorOnly(
      [1, 0, 0],
      [
        diagnosticChunk({
          documentTitle: "Expected",
          sectionPath: "Expected > Section",
          embedding: [0.8, 0.2, 0],
        }),
        diagnosticChunk({
          documentTitle: "Other",
          sectionPath: "Other > Section",
          embedding: [0, 1, 0],
        }),
      ],
    );

    expect(ranking[0]).toMatchObject({
      documentTitle: "Expected",
      rank: 1,
    });
    expect(ranking[0].similarity).toBeGreaterThan(ranking[1].similarity ?? 0);
  });

  it("ranks lexical-only candidates with deterministic overlap scores", () => {
    const ranking = rankLexicalOnly("registro asistencia estudiante", [
      diagnosticChunk({
        documentTitle: "Expected",
        sectionPath: "Expected > Asistencia",
        content: "registro asistencia estudiante docente",
      }),
      diagnosticChunk({
        documentTitle: "Other",
        sectionPath: "Other > Pagos",
        content: "cuotas pagos financiera",
      }),
    ]);

    expect(ranking).toHaveLength(1);
    expect(ranking[0]).toMatchObject({
      documentTitle: "Expected",
      rank: 1,
      textScore: 1,
    });
  });

  it("classifies component comparison outcomes", () => {
    expect(
      classifyComponentComparison({
        hybridPassed: false,
        vectorPassed: true,
        lexicalPassed: false,
        vectorHasExpected: true,
        lexicalHasExpected: false,
        hybridExpectedRank: null,
        vectorExpectedRank: 1,
      }),
    ).toBe("vector_succeeds_hybrid_fails");

    expect(
      classifyComponentComparison({
        hybridPassed: false,
        vectorPassed: false,
        lexicalPassed: false,
        vectorHasExpected: false,
        lexicalHasExpected: false,
        hybridExpectedRank: null,
        vectorExpectedRank: null,
      }),
    ).toBe("expected_absent_from_both_components");
  });

  it("calculates what-if metrics from diagnostic rankings", () => {
    const positive = evaluateCase(fixtureCase({ id: "positive" }), [result()], {
      vectorOnly: {
        top1Document: "Módulo 11: Calificación",
        top1Section: "Módulo 11: Calificación > Control de asistencias",
        expectedDocumentRank: 1,
        expectedSectionRank: 1,
        expectedDocumentTop1: true,
        expectedDocumentTopK: true,
        expectedSectionTopK: true,
        top1Similarity: 0.9,
        expectedBestSimilarity: 0.9,
        top1ExpectedSimilarityGap: 0,
      },
      lexicalOnly: {
        top1Document: null,
        top1Section: null,
        expectedDocumentRank: null,
        expectedSectionRank: null,
        expectedDocumentTop1: false,
        expectedDocumentTopK: false,
        expectedSectionTopK: false,
        anyLexicalResult: false,
        expectedBestTextScore: null,
      },
      hybrid: {
        top1Document: "Módulo 11: Calificación",
        top1Section: "Módulo 11: Calificación > Control de asistencias",
        expectedDocumentRank: 1,
        expectedSectionRank: 1,
        expectedDocumentTop1: true,
        expectedDocumentTopK: true,
        expectedSectionTopK: true,
      },
      fusion: {
        top1Document: "Módulo 11: Calificación",
        top1Section: "Módulo 11: Calificación > Control de asistencias",
        expectedDocumentRank: 1,
        expectedSectionRank: 1,
        expectedDocumentTop1: true,
        expectedDocumentTopK: true,
        expectedSectionTopK: true,
        expectedBestVectorRank: 1,
        expectedBestLexicalRank: null,
        expectedBestFusedRank: 1,
        expectedBestVectorContribution: 0.0196,
        expectedBestTextContribution: 0,
        expectedBestFusedScore: 0.0196,
        fusionAssessment: "neutral",
      },
      rankings: {
        vectorTopK: [
          {
            rank: 1,
            documentTitle: "Módulo 11: Calificación",
            sectionPath: "Módulo 11: Calificación > Control de asistencias",
            contentPreview: "registro asistencia estudiante",
            tokenEstimate: 40,
            similarity: 0.9,
          },
        ],
        lexicalTopK: [],
        hybridTopK: [
          {
            rank: 1,
            documentTitle: "Módulo 11: Calificación",
            sectionPath: "Módulo 11: Calificación > Control de asistencias",
            contentPreview: "registro asistencia estudiante",
            tokenEstimate: 40,
            fusedScore: 0.0196,
          },
        ],
        vectorDominantTopK: [
          {
            rank: 1,
            documentTitle: "Módulo 11: Calificación",
            sectionPath: "Módulo 11: Calificación > Control de asistencias",
            contentPreview: "registro asistencia estudiante",
            tokenEstimate: 40,
            fusedScore: 0.0392,
          },
        ],
      },
      componentComparison: "hybrid_equals_vector",
      failureCause: null,
      chunkRepresentation: null,
      queryAnalysis: null,
    });

    const metrics = calculateWhatIfMetrics(
      [positive],
      (observation) => observation.componentDiagnostics?.rankings.vectorTopK ?? [],
    );

    expect(metrics).toMatchObject({
      totalCases: 1,
      top1DocumentAccuracy: 1,
      topKDocumentRecall: 1,
      top1SectionAccuracy: 1,
      topKSectionHit: 1,
    });
  });
});
