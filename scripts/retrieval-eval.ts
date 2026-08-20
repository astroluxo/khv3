import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenAIEmbeddingClient,
  createEmbeddingConfig,
  type EmbeddingClient,
} from "../supabase/functions/_shared/openai.ts";
import {
  retrieveKnowledge,
  type HybridSearchRpcArgs,
  type RetrievalResult,
  type RetrievalRpcClient,
} from "../supabase/functions/_shared/retrieval.ts";

const DEFAULT_FIXTURE_PATH = "fixtures/retrieval_eval_phase8.json";
const DEFAULT_PARAPHRASE_FIXTURE_PATH = "fixtures/retrieval_eval_phase9c_paraphrases.json";
const DEFAULT_OUTPUT_PATH = ".supabase/retrieval-eval-phase9.json";
const DEFAULT_LIMIT = 6;
const DEFAULT_SUPPORTING_CHUNK_OVERLAP = 0.35;

type EvalExpected = {
  documentTitle: string | null;
  area: string | null;
  sectionContains: string | null;
  shouldHaveEvidence: boolean;
  nearNegative?: boolean;
  relatedDocumentTitle?: string | null;
  unsupportedRationale?: string | null;
};

export type EvalCase = {
  id: string;
  question: string;
  expected: EvalExpected;
  suite?: "original" | "paraphrase";
};

export type CandidateObservation = {
  rank: number;
  documentTitle: string;
  area: string | null;
  sectionPath: string | null;
  vectorRank: number | null;
  lexicalRank: number | null;
  fusedScore: number;
  queryOverlap: number;
};

export type CaseSignals = {
  lexicalResultCount: number;
  vectorResultCount: number;
  agreementResultCount: number;
  top1HasLexical: boolean;
  top1HasVector: boolean;
  top1HasAgreement: boolean;
  top1FusedScore: number | null;
  top2FusedScore: number | null;
  fusedScoreGap: number | null;
  top1QueryOverlap: number;
  maxQueryOverlap: number;
  uniqueDocumentCount: number;
  topDocumentResultCount: number;
  topDocumentShare: number;
  topDocumentDistinctSectionCount: number;
  dominantDocument: string | null;
  dominantDocumentConcentration: number;
  dominantSection: string | null;
  dominantSectionConcentration: number;
  supportingChunkCount: number;
  top1Top2DocumentAgreement: boolean;
  queryTokenCoverage: number;
  specificTokenCoverage: number;
};

export type CaseObservation = {
  id: string;
  question: string;
  suite: "original" | "paraphrase";
  expected: EvalExpected;
  classification: "positive" | "far_negative" | "near_negative";
  retrievedResultCount: number;
  top1Document: string | null;
  top1Area: string | null;
  top1Section: string | null;
  expectedDocumentRank: number | null;
  expectedSectionRank: number | null;
  expectedDocumentTop1: boolean;
  expectedDocumentTop3: boolean;
  expectedDocumentTopK: boolean;
  expectedSectionTop1: boolean;
  expectedSectionTopK: boolean;
  negativeReturnedEvidence: boolean;
  candidates: CandidateObservation[];
  signals: CaseSignals;
};

export type RetrievalSummary = {
  totalCases: number;
  positiveCases: number;
  farNegativeCases: number;
  nearNegativeCases: number;
  negativeCases: number;
  positiveTop1DocumentAccuracy: number;
  positiveTop3DocumentRecall: number;
  positiveTopKDocumentRecall: number;
  positiveTop1SectionAccuracy: number;
  positiveSectionHitRate: number;
  negativeZeroEvidenceRate: number;
  negativeIrrelevantEvidenceRate: number;
  farNegativeZeroEvidenceRate: number;
  farNegativeIrrelevantEvidenceRate: number;
  nearNegativeZeroEvidenceRate: number;
  nearNegativeIrrelevantEvidenceRate: number;
  perArea: Record<
    string,
    {
      count: number;
      top1DocumentAccuracy: number;
      top3DocumentRecall: number;
      topKDocumentRecall: number;
      top1SectionAccuracy: number;
      sectionHitRate: number;
    }
  >;
};

export type StrategyId =
  | "strategy0_any_retrieval"
  | "strategy1_vector_lexical_agreement"
  | "strategy2_lexical_coverage"
  | "strategy3_rank_separation_proxy"
  | "strategy4_combined_deterministic";

export type StrategyDecision = {
  strategyId: StrategyId | CompositeStrategyId;
  label: string;
  sufficient: boolean;
  reason: string;
};

export type ConfusionMetrics = {
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number;
  recall: number;
  specificity: number;
  accuracy: number;
  farNegativeFalsePositiveRate: number;
  nearNegativeFalsePositiveRate: number;
  rejectedPositiveCaseIds: string[];
  acceptedNegativeCaseIds: string[];
  acceptedFarNegativeCaseIds: string[];
  acceptedNearNegativeCaseIds: string[];
};

export type StrategyComparison = {
  strategyId: StrategyId | CompositeStrategyId;
  label: string;
  metrics: ConfusionMetrics;
};

export type BenchmarkArtifact = {
  generatedAt: string;
  fixturePath: string;
  paraphraseFixturePath: string;
  retrievalLimit: number;
  openAIQueryEmbeddingRequests: number;
  summary: RetrievalSummary;
  paraphraseSummary: RetrievalSummary;
  strategyComparison: StrategyComparison[];
  compositeStrategyComparison: StrategyComparison[];
  paraphraseCompositeStrategyComparison: StrategyComparison[];
  lexicalOverlapDistributions: {
    positiveMaxOverlap: DistributionSummary;
    farNegativeMaxOverlap: DistributionSummary;
    nearNegativeMaxOverlap: DistributionSummary;
  };
  compositeSignalDistributions: CompositeSignalDistributions;
  paraphraseCompositeSignalDistributions: CompositeSignalDistributions;
  lexicalThresholdSweep: ThresholdComparison[];
  compositeParameterSweep: CompositeSweepResult[];
  paraphraseCompositeParameterSweep: CompositeSweepResult[];
  bestCompositeCandidate: StrategyComparison | null;
  observations: CaseObservation[];
  notes: string[];
};

export type DistributionSummary = {
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  max: number | null;
};

export type CompositeSignalDistributions = Record<
  "positive" | "farNegative" | "nearNegative",
  {
    maxLexicalOverlap: DistributionSummary;
    topDocumentConcentration: DistributionSummary;
    topSectionConcentration: DistributionSummary;
    supportingChunkCount: DistributionSummary;
    queryTokenCoverage: DistributionSummary;
    specificTokenCoverage: DistributionSummary;
  }
>;

export type ThresholdComparison = {
  threshold: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  positiveRecall: number;
  farNegativeSpecificity: number;
  nearNegativeSpecificity: number;
  totalSpecificity: number;
  falsePositiveCaseIds: string[];
  falseNegativeCaseIds: string[];
};

export type CompositeStrategyId =
  | "c0_lexical_only"
  | "c1_overlap_query_coverage"
  | "c2_overlap_supporting_chunks"
  | "c3_overlap_document_concentration"
  | "c4_overlap_section_concentration"
  | "c5_overlap_specific_token_coverage"
  | "c6_simple_three_signal";

export type CompositeSweepResult = {
  strategyId: CompositeStrategyId;
  label: string;
  params: Record<string, number>;
  metrics: ConfusionMetrics;
};

type RuntimeEnv = Record<string, string | undefined>;

class FetchRpcClient implements RetrievalRpcClient {
  private readonly supabaseUrl: string;
  private readonly serviceRoleKey: string;

  constructor(options: { supabaseUrl: string; serviceRoleKey: string }) {
    this.supabaseUrl = options.supabaseUrl.replace(/\/$/, "");
    this.serviceRoleKey = options.serviceRoleKey;
  }

  async rpc(
    functionName: "hybrid_search",
    args: HybridSearchRpcArgs,
  ): Promise<{ data: unknown; error: unknown }> {
    const response = await fetch(`${this.supabaseUrl}/rest/v1/rpc/${functionName}`, {
      method: "POST",
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(args),
    });

    if (!response.ok) {
      return { data: null, error: await safeErrorPayload(response) };
    }

    return { data: await response.json(), error: null };
  }
}

class CountingEmbeddingClient implements EmbeddingClient {
  readonly dimensions: number;
  requestCount = 0;
  private readonly inner: EmbeddingClient;

  constructor(inner: EmbeddingClient) {
    this.inner = inner;
    this.dimensions = inner.dimensions;
  }

  async embedMany(inputs: string[]): Promise<number[][]> {
    if (inputs.length > 0) this.requestCount += 1;
    return this.inner.embedMany(inputs);
  }
}

export function loadFixtureCases(path: string, suite: EvalCase["suite"] = "original"): EvalCase[] {
  return validateFixtureCases(JSON.parse(readFileSync(path, "utf8")), suite);
}

export function validateFixtureCases(
  value: unknown,
  suite: EvalCase["suite"] = "original",
): EvalCase[] {
  if (!Array.isArray(value)) {
    throw new Error("Retrieval fixture must be a JSON array");
  }

  const ids = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Retrieval fixture case ${index} must be an object`);
    if (typeof item.id !== "string" || item.id.trim() === "") {
      throw new Error(`Retrieval fixture case ${index} is missing id`);
    }
    if (ids.has(item.id)) throw new Error(`Retrieval fixture case id is duplicated: ${item.id}`);
    ids.add(item.id);
    if (typeof item.question !== "string" || item.question.trim() === "") {
      throw new Error(`Retrieval fixture case ${item.id} is missing question`);
    }
    if (!isRecord(item.expected)) {
      throw new Error(`Retrieval fixture case ${item.id} is missing expected`);
    }

    const expected = item.expected;
    if (typeof expected.shouldHaveEvidence !== "boolean") {
      throw new Error(`Retrieval fixture case ${item.id} has invalid shouldHaveEvidence`);
    }
    const documentTitle = nullableString(expected.documentTitle);
    const area = nullableString(expected.area);
    const sectionContains = nullableString(expected.sectionContains);
    const nearNegative = expected.nearNegative === true;
    const relatedDocumentTitle = nullableString(expected.relatedDocumentTitle);
    const unsupportedRationale = nullableString(expected.unsupportedRationale);

    if (expected.shouldHaveEvidence) {
      if (!documentTitle || !area || !sectionContains) {
        throw new Error(`Positive fixture case ${item.id} must include document, area, section`);
      }
      if (nearNegative) {
        throw new Error(`Positive fixture case ${item.id} must not be marked nearNegative`);
      }
    } else {
      if (documentTitle !== null || sectionContains !== null) {
        throw new Error(`Negative fixture case ${item.id} must use null document and section`);
      }
      if (nearNegative && (!area || !relatedDocumentTitle || !unsupportedRationale)) {
        throw new Error(
          `Near-negative fixture case ${item.id} must include area, relatedDocumentTitle, and unsupportedRationale`,
        );
      }
      if (!nearNegative && (relatedDocumentTitle !== null || unsupportedRationale !== null)) {
        throw new Error(
          `Far-negative fixture case ${item.id} must not include near-negative metadata`,
        );
      }
    }

    return {
      id: item.id,
      question: item.question,
      suite,
      expected: {
        documentTitle,
        area,
        sectionContains,
        shouldHaveEvidence: expected.shouldHaveEvidence,
        ...(nearNegative ? { nearNegative } : {}),
        ...(relatedDocumentTitle ? { relatedDocumentTitle } : {}),
        ...(unsupportedRationale ? { unsupportedRationale } : {}),
      },
    };
  });
}

export function evaluateCase(testCase: EvalCase, results: RetrievalResult[]): CaseObservation {
  const candidates = results.map((result, index) => mapCandidate(result, index, testCase.question));
  const expectedDocumentRank = findExpectedDocumentRank(testCase, results);
  const expectedSectionRank = findExpectedSectionRank(testCase, results);
  const top = results[0];

  return {
    id: testCase.id,
    question: testCase.question,
    suite: testCase.suite ?? "original",
    expected: testCase.expected,
    classification: classifyCase(testCase),
    retrievedResultCount: results.length,
    top1Document: top?.document.title ?? null,
    top1Area: top?.document.area ?? null,
    top1Section: top?.sectionPath ?? null,
    expectedDocumentRank,
    expectedSectionRank,
    expectedDocumentTop1: expectedDocumentRank === 1,
    expectedDocumentTop3: expectedDocumentRank !== null && expectedDocumentRank <= 3,
    expectedDocumentTopK: expectedDocumentRank !== null,
    expectedSectionTop1: expectedSectionRank === 1,
    expectedSectionTopK: expectedSectionRank !== null,
    negativeReturnedEvidence: !testCase.expected.shouldHaveEvidence && results.length > 0,
    candidates,
    signals: calculateSignals(candidates, testCase.question, results),
  };
}

export function summarizeObservations(observations: CaseObservation[]): RetrievalSummary {
  const positives = observations.filter((observation) => observation.expected.shouldHaveEvidence);
  const negatives = observations.filter((observation) => !observation.expected.shouldHaveEvidence);
  const farNegatives = observations.filter(
    (observation) => observation.classification === "far_negative",
  );
  const nearNegatives = observations.filter(
    (observation) => observation.classification === "near_negative",
  );
  const perArea: RetrievalSummary["perArea"] = {};

  for (const observation of positives) {
    const area = observation.expected.area ?? "unknown";
    const current = perArea[area] ?? {
      count: 0,
      top1DocumentAccuracy: 0,
      top3DocumentRecall: 0,
      topKDocumentRecall: 0,
      top1SectionAccuracy: 0,
      sectionHitRate: 0,
    };
    current.count += 1;
    current.top1DocumentAccuracy += observation.expectedDocumentTop1 ? 1 : 0;
    current.top3DocumentRecall += observation.expectedDocumentTop3 ? 1 : 0;
    current.topKDocumentRecall += observation.expectedDocumentTopK ? 1 : 0;
    current.top1SectionAccuracy += observation.expectedSectionTop1 ? 1 : 0;
    current.sectionHitRate += observation.expectedSectionTopK ? 1 : 0;
    perArea[area] = current;
  }

  for (const [area, current] of Object.entries(perArea)) {
    perArea[area] = {
      count: current.count,
      top1DocumentAccuracy: ratio(current.top1DocumentAccuracy, current.count),
      top3DocumentRecall: ratio(current.top3DocumentRecall, current.count),
      topKDocumentRecall: ratio(current.topKDocumentRecall, current.count),
      top1SectionAccuracy: ratio(current.top1SectionAccuracy, current.count),
      sectionHitRate: ratio(current.sectionHitRate, current.count),
    };
  }

  return {
    totalCases: observations.length,
    positiveCases: positives.length,
    farNegativeCases: farNegatives.length,
    nearNegativeCases: nearNegatives.length,
    negativeCases: negatives.length,
    positiveTop1DocumentAccuracy: ratio(
      positives.filter((observation) => observation.expectedDocumentTop1).length,
      positives.length,
    ),
    positiveTop3DocumentRecall: ratio(
      positives.filter((observation) => observation.expectedDocumentTop3).length,
      positives.length,
    ),
    positiveTopKDocumentRecall: ratio(
      positives.filter((observation) => observation.expectedDocumentTopK).length,
      positives.length,
    ),
    positiveTop1SectionAccuracy: ratio(
      positives.filter((observation) => observation.expectedSectionTop1).length,
      positives.length,
    ),
    positiveSectionHitRate: ratio(
      positives.filter((observation) => observation.expectedSectionTopK).length,
      positives.length,
    ),
    negativeZeroEvidenceRate: ratio(
      negatives.filter((observation) => observation.retrievedResultCount === 0).length,
      negatives.length,
    ),
    negativeIrrelevantEvidenceRate: ratio(
      negatives.filter((observation) => observation.retrievedResultCount > 0).length,
      negatives.length,
    ),
    farNegativeZeroEvidenceRate: zeroEvidenceRate(farNegatives),
    farNegativeIrrelevantEvidenceRate: irrelevantEvidenceRate(farNegatives),
    nearNegativeZeroEvidenceRate: zeroEvidenceRate(nearNegatives),
    nearNegativeIrrelevantEvidenceRate: irrelevantEvidenceRate(nearNegatives),
    perArea,
  };
}

export function getSufficiencyStrategies(): Array<{
  id: StrategyId;
  label: string;
  decide: (observation: CaseObservation) => StrategyDecision;
}> {
  return [
    {
      id: "strategy0_any_retrieval",
      label: "Current behavior: any nonempty retrieval is sufficient",
      decide: (observation) =>
        decision(
          "strategy0_any_retrieval",
          "Current behavior: any nonempty retrieval is sufficient",
          observation.retrievedResultCount > 0,
          `retrieved=${observation.retrievedResultCount}`,
        ),
    },
    {
      id: "strategy1_vector_lexical_agreement",
      label: "Require vector and lexical agreement in the retrieved set",
      decide: (observation) =>
        decision(
          "strategy1_vector_lexical_agreement",
          "Require vector and lexical agreement in the retrieved set",
          observation.signals.top1HasAgreement || observation.signals.agreementResultCount >= 2,
          `top1Agreement=${observation.signals.top1HasAgreement}; agreementCount=${observation.signals.agreementResultCount}`,
        ),
    },
    {
      id: "strategy2_lexical_coverage",
      label: "Require meaningful query-term coverage in retrieved text",
      decide: (observation) =>
        decision(
          "strategy2_lexical_coverage",
          "Require meaningful query-term coverage in retrieved text",
          observation.signals.top1QueryOverlap >= 0.35 ||
            observation.signals.maxQueryOverlap >= 0.35,
          `top1Overlap=${round(observation.signals.top1QueryOverlap)}; maxOverlap=${round(observation.signals.maxQueryOverlap)}`,
        ),
    },
    {
      id: "strategy3_rank_separation_proxy",
      label: "Use RRF rank separation proxy when top document is concentrated",
      decide: (observation) =>
        decision(
          "strategy3_rank_separation_proxy",
          "Use RRF rank separation proxy when top document is concentrated",
          observation.signals.top1HasVector &&
            observation.signals.topDocumentShare >= 0.5 &&
            (observation.signals.fusedScoreGap ?? 0) >= 0.002,
          `topDocShare=${round(observation.signals.topDocumentShare)}; fusedGap=${round(observation.signals.fusedScoreGap ?? 0)}`,
        ),
    },
    {
      id: "strategy4_combined_deterministic",
      label: "Combined agreement, lexical coverage, and document concentration rule",
      decide: (observation) => {
        const agreementWithCoverage =
          observation.signals.top1HasAgreement && observation.signals.top1QueryOverlap >= 0.2;
        const lexicalConcentration =
          observation.signals.lexicalResultCount >= 2 &&
          observation.signals.topDocumentShare >= 0.5 &&
          observation.signals.maxQueryOverlap >= 0.35;
        const highCoverage =
          observation.signals.topDocumentShare >= 0.5 && observation.signals.maxQueryOverlap >= 0.6;

        return decision(
          "strategy4_combined_deterministic",
          "Combined agreement, lexical coverage, and document concentration rule",
          agreementWithCoverage || lexicalConcentration || highCoverage,
          `agreementWithCoverage=${agreementWithCoverage}; lexicalConcentration=${lexicalConcentration}; highCoverage=${highCoverage}`,
        );
      },
    },
  ];
}

export function evaluateStrategies(observations: CaseObservation[]): StrategyComparison[] {
  return getSufficiencyStrategies().map((strategy) => ({
    strategyId: strategy.id,
    label: strategy.label,
    metrics: calculateConfusionMetrics(
      observations.map((observation) => ({
        observation,
        decision: strategy.decide(observation),
      })),
    ),
  }));
}

export function calculateConfusionMetrics(
  decisions: Array<{ observation: CaseObservation; decision: StrategyDecision }>,
): ConfusionMetrics {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  const rejectedPositiveCaseIds: string[] = [];
  const acceptedNegativeCaseIds: string[] = [];
  const acceptedFarNegativeCaseIds: string[] = [];
  const acceptedNearNegativeCaseIds: string[] = [];

  for (const { observation, decision: strategyDecision } of decisions) {
    const expectedPositive = observation.expected.shouldHaveEvidence;
    if (expectedPositive && strategyDecision.sufficient) truePositive += 1;
    if (!expectedPositive && strategyDecision.sufficient) {
      falsePositive += 1;
      acceptedNegativeCaseIds.push(observation.id);
      if (observation.classification === "far_negative") {
        acceptedFarNegativeCaseIds.push(observation.id);
      }
      if (observation.classification === "near_negative") {
        acceptedNearNegativeCaseIds.push(observation.id);
      }
    }
    if (!expectedPositive && !strategyDecision.sufficient) trueNegative += 1;
    if (expectedPositive && !strategyDecision.sufficient) {
      falseNegative += 1;
      rejectedPositiveCaseIds.push(observation.id);
    }
  }

  return {
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision: ratio(truePositive, truePositive + falsePositive),
    recall: ratio(truePositive, truePositive + falseNegative),
    specificity: ratio(trueNegative, trueNegative + falsePositive),
    accuracy: ratio(truePositive + trueNegative, decisions.length),
    farNegativeFalsePositiveRate: ratio(
      acceptedFarNegativeCaseIds.length,
      decisions.filter(({ observation }) => observation.classification === "far_negative").length,
    ),
    nearNegativeFalsePositiveRate: ratio(
      acceptedNearNegativeCaseIds.length,
      decisions.filter(({ observation }) => observation.classification === "near_negative").length,
    ),
    rejectedPositiveCaseIds,
    acceptedNegativeCaseIds,
    acceptedFarNegativeCaseIds,
    acceptedNearNegativeCaseIds,
  };
}

export function summarizeLexicalOverlapDistributions(observations: CaseObservation[]): {
  positiveMaxOverlap: DistributionSummary;
  farNegativeMaxOverlap: DistributionSummary;
  nearNegativeMaxOverlap: DistributionSummary;
} {
  return {
    positiveMaxOverlap: distribution(
      observations
        .filter((observation) => observation.classification === "positive")
        .map((observation) => observation.signals.maxQueryOverlap),
    ),
    farNegativeMaxOverlap: distribution(
      observations
        .filter((observation) => observation.classification === "far_negative")
        .map((observation) => observation.signals.maxQueryOverlap),
    ),
    nearNegativeMaxOverlap: distribution(
      observations
        .filter((observation) => observation.classification === "near_negative")
        .map((observation) => observation.signals.maxQueryOverlap),
    ),
  };
}

export function summarizeCompositeSignalDistributions(
  observations: CaseObservation[],
): CompositeSignalDistributions {
  return {
    positive: signalDistributionFor(observations, "positive"),
    farNegative: signalDistributionFor(observations, "far_negative"),
    nearNegative: signalDistributionFor(observations, "near_negative"),
  };
}

export function evaluateLexicalThresholds(
  observations: CaseObservation[],
  thresholds = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6],
): ThresholdComparison[] {
  return thresholds.map((threshold) => {
    const decisions = observations.map((observation) => ({
      observation,
      sufficient: observation.signals.maxQueryOverlap >= threshold,
    }));
    const falsePositiveCaseIds = decisions
      .filter(
        ({ observation, sufficient }) => !observation.expected.shouldHaveEvidence && sufficient,
      )
      .map(({ observation }) => observation.id);
    const falseNegativeCaseIds = decisions
      .filter(
        ({ observation, sufficient }) => observation.expected.shouldHaveEvidence && !sufficient,
      )
      .map(({ observation }) => observation.id);
    const truePositive = decisions.filter(
      ({ observation, sufficient }) => observation.expected.shouldHaveEvidence && sufficient,
    ).length;
    const falsePositive = falsePositiveCaseIds.length;
    const trueNegative = decisions.filter(
      ({ observation, sufficient }) => !observation.expected.shouldHaveEvidence && !sufficient,
    ).length;
    const falseNegative = falseNegativeCaseIds.length;

    return {
      threshold,
      truePositive,
      falsePositive,
      trueNegative,
      falseNegative,
      positiveRecall: ratio(truePositive, truePositive + falseNegative),
      farNegativeSpecificity: specificityFor(decisions, "far_negative"),
      nearNegativeSpecificity: specificityFor(decisions, "near_negative"),
      totalSpecificity: ratio(trueNegative, trueNegative + falsePositive),
      falsePositiveCaseIds,
      falseNegativeCaseIds,
    };
  });
}

export function evaluateCompositeStrategies(observations: CaseObservation[]): StrategyComparison[] {
  const candidates: Array<{
    id: CompositeStrategyId;
    label: string;
    sufficient: (observation: CaseObservation) => boolean;
  }> = [
    {
      id: "c0_lexical_only",
      label: "C0 lexical overlap only",
      sufficient: (observation) => observation.signals.maxQueryOverlap >= 0.35,
    },
    {
      id: "c1_overlap_query_coverage",
      label: "C1 lexical overlap plus query token coverage",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.queryTokenCoverage >= 0.6,
    },
    {
      id: "c2_overlap_supporting_chunks",
      label: "C2 lexical overlap plus supporting chunk count",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.supportingChunkCount >= 2,
    },
    {
      id: "c3_overlap_document_concentration",
      label: "C3 lexical overlap plus dominant-document concentration",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.dominantDocumentConcentration >= 0.5,
    },
    {
      id: "c4_overlap_section_concentration",
      label: "C4 lexical overlap plus section concentration",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.dominantSectionConcentration >= 0.34,
    },
    {
      id: "c5_overlap_specific_token_coverage",
      label: "C5 lexical overlap plus specific-token coverage",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.specificTokenCoverage >= 0.5,
    },
    {
      id: "c6_simple_three_signal",
      label: "C6 lexical overlap plus support and coverage",
      sufficient: (observation) =>
        observation.signals.maxQueryOverlap >= 0.35 &&
        observation.signals.supportingChunkCount >= 1 &&
        observation.signals.specificTokenCoverage >= 0.5,
    },
  ];

  return candidates.map((candidate) => ({
    strategyId: candidate.id,
    label: candidate.label,
    metrics: calculateConfusionMetrics(
      observations.map((observation) => ({
        observation,
        decision: decision(
          candidate.id,
          candidate.label,
          candidate.sufficient(observation),
          "offline composite rule",
        ),
      })),
    ),
  }));
}

export function evaluateCompositeParameterSweep(
  observations: CaseObservation[],
): CompositeSweepResult[] {
  const results: CompositeSweepResult[] = [];
  const lexicalThresholds = [0.25, 0.3, 0.35, 0.4, 0.45];
  const coverageThresholds = [0.4, 0.5, 0.6, 0.7];
  const concentrationThresholds = [0.34, 0.5, 0.67];
  const supportingChunkCounts = [1, 2, 3];

  for (const lexical of lexicalThresholds) {
    results.push(
      compositeSweepResult(
        "c0_lexical_only",
        "C0 lexical overlap only",
        { lexical },
        observations,
        (observation) => observation.signals.maxQueryOverlap >= lexical,
      ),
    );
    for (const coverage of coverageThresholds) {
      results.push(
        compositeSweepResult(
          "c1_overlap_query_coverage",
          "C1 lexical overlap plus query token coverage",
          { lexical, coverage },
          observations,
          (observation) =>
            observation.signals.maxQueryOverlap >= lexical &&
            observation.signals.queryTokenCoverage >= coverage,
        ),
      );
      results.push(
        compositeSweepResult(
          "c5_overlap_specific_token_coverage",
          "C5 lexical overlap plus specific-token coverage",
          { lexical, coverage },
          observations,
          (observation) =>
            observation.signals.maxQueryOverlap >= lexical &&
            observation.signals.specificTokenCoverage >= coverage,
        ),
      );
    }
    for (const minimumChunks of supportingChunkCounts) {
      results.push(
        compositeSweepResult(
          "c2_overlap_supporting_chunks",
          "C2 lexical overlap plus supporting chunk count",
          { lexical, minimumChunks },
          observations,
          (observation) =>
            observation.signals.maxQueryOverlap >= lexical &&
            observation.signals.supportingChunkCount >= minimumChunks,
        ),
      );
    }
    for (const concentration of concentrationThresholds) {
      results.push(
        compositeSweepResult(
          "c3_overlap_document_concentration",
          "C3 lexical overlap plus dominant-document concentration",
          { lexical, concentration },
          observations,
          (observation) =>
            observation.signals.maxQueryOverlap >= lexical &&
            observation.signals.dominantDocumentConcentration >= concentration,
        ),
      );
      results.push(
        compositeSweepResult(
          "c4_overlap_section_concentration",
          "C4 lexical overlap plus section concentration",
          { lexical, concentration },
          observations,
          (observation) =>
            observation.signals.maxQueryOverlap >= lexical &&
            observation.signals.dominantSectionConcentration >= concentration,
        ),
      );
    }
    for (const minimumChunks of [1, 2]) {
      for (const coverage of [0.4, 0.5, 0.6]) {
        results.push(
          compositeSweepResult(
            "c6_simple_three_signal",
            "C6 lexical overlap plus support and coverage",
            { lexical, minimumChunks, coverage },
            observations,
            (observation) =>
              observation.signals.maxQueryOverlap >= lexical &&
              observation.signals.supportingChunkCount >= minimumChunks &&
              observation.signals.specificTokenCoverage >= coverage,
          ),
        );
      }
    }
  }

  return results.sort(compareCompositeResults);
}

export async function runRetrievalBenchmark(options: {
  fixturePath: string;
  paraphraseFixturePath: string;
  outputPath: string;
  env: RuntimeEnv;
  now?: () => Date;
}): Promise<BenchmarkArtifact> {
  const originalCases = loadFixtureCases(options.fixturePath, "original");
  const paraphraseCases = loadFixtureCases(options.paraphraseFixturePath, "paraphrase");
  const cases = [...originalCases, ...paraphraseCases];
  const embeddingConfig = createEmbeddingConfig({ get: (name) => options.env[name] });
  const embeddingClient = new CountingEmbeddingClient(
    new OpenAIEmbeddingClient({
      apiKey: required(options.env.OPENAI_API_KEY, "OPENAI_API_KEY"),
      model: embeddingConfig.model,
      dimensions: embeddingConfig.dimensions,
    }),
  );
  const supabase = new FetchRpcClient({
    supabaseUrl: required(options.env.SUPABASE_URL, "SUPABASE_URL"),
    serviceRoleKey: required(options.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"),
  });

  const observations: CaseObservation[] = [];
  for (const testCase of cases) {
    const results = await retrieveKnowledge({
      query: testCase.question,
      supabase,
      embeddingClient,
      options: { limit: DEFAULT_LIMIT, filters: { accessScopes: ["default"] } },
    });
    observations.push(evaluateCase(testCase, results));
  }
  const originalObservations = observations.filter(
    (observation) => observation.suite === "original",
  );
  const paraphraseObservations = observations.filter(
    (observation) => observation.suite === "paraphrase",
  );
  const originalCompositeStrategies = evaluateCompositeStrategies(originalObservations);
  const paraphraseCompositeStrategies = evaluateCompositeStrategies(paraphraseObservations);

  const artifact: BenchmarkArtifact = {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    fixturePath: options.fixturePath,
    paraphraseFixturePath: options.paraphraseFixturePath,
    retrievalLimit: DEFAULT_LIMIT,
    openAIQueryEmbeddingRequests: embeddingClient.requestCount,
    summary: summarizeObservations(originalObservations),
    paraphraseSummary: summarizeObservations(paraphraseObservations),
    strategyComparison: evaluateStrategies(originalObservations),
    compositeStrategyComparison: originalCompositeStrategies,
    paraphraseCompositeStrategyComparison: paraphraseCompositeStrategies,
    lexicalOverlapDistributions: summarizeLexicalOverlapDistributions(originalObservations),
    compositeSignalDistributions: summarizeCompositeSignalDistributions(originalObservations),
    paraphraseCompositeSignalDistributions:
      summarizeCompositeSignalDistributions(paraphraseObservations),
    lexicalThresholdSweep: evaluateLexicalThresholds(originalObservations),
    compositeParameterSweep: evaluateCompositeParameterSweep(originalObservations),
    paraphraseCompositeParameterSweep: evaluateCompositeParameterSweep(paraphraseObservations),
    bestCompositeCandidate: chooseBestCompositeCandidate(
      originalCompositeStrategies,
      paraphraseCompositeStrategies,
    ),
    observations,
    notes: [
      "No raw embeddings, secrets, JWTs, or service-role credentials are stored in this artifact.",
      "Cosine similarity is not exposed by the production retrieval RPC; strategy3 uses only an RRF rank-separation proxy.",
      "This benchmark observes production retrieval behavior but does not change ranking or sufficiency gates.",
      "Phase 9C composite strategies are offline experiments only and are not production sufficiency gates.",
    ],
  };

  mkdirSync(dirname(options.outputPath), { recursive: true });
  writeFileSync(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function mapCandidate(
  result: RetrievalResult,
  index: number,
  question: string,
): CandidateObservation {
  return {
    rank: index + 1,
    documentTitle: result.document.title,
    area: result.document.area ?? null,
    sectionPath: result.sectionPath ?? null,
    vectorRank: result.diagnostics.vectorRank ?? null,
    lexicalRank: result.diagnostics.textRank ?? null,
    fusedScore: result.diagnostics.fusedScore,
    queryOverlap: queryOverlap(question, [
      result.document.title,
      result.sectionPath ?? "",
      result.content,
    ]),
  };
}

function calculateSignals(
  candidates: CandidateObservation[],
  question: string,
  results: RetrievalResult[],
): CaseSignals {
  const top = candidates[0];
  const second = candidates[1];
  const topDocument = top?.documentTitle ?? null;
  const topDocumentCandidates = topDocument
    ? candidates.filter((candidate) => candidate.documentTitle === topDocument)
    : [];
  const dominantDocumentGroup = largestGroup(candidates, (candidate) => candidate.documentTitle);
  const dominantSectionGroup = largestGroup(
    candidates,
    (candidate) => candidate.sectionPath ?? candidate.documentTitle,
  );
  const distinctTopSections = new Set(
    topDocumentCandidates.map((candidate) => candidate.sectionPath ?? ""),
  );

  return {
    lexicalResultCount: candidates.filter((candidate) => candidate.lexicalRank !== null).length,
    vectorResultCount: candidates.filter((candidate) => candidate.vectorRank !== null).length,
    agreementResultCount: candidates.filter(
      (candidate) => candidate.vectorRank !== null && candidate.lexicalRank !== null,
    ).length,
    top1HasLexical: top?.lexicalRank !== null && top?.lexicalRank !== undefined,
    top1HasVector: top?.vectorRank !== null && top?.vectorRank !== undefined,
    top1HasAgreement:
      top?.vectorRank !== null &&
      top?.vectorRank !== undefined &&
      top?.lexicalRank !== null &&
      top?.lexicalRank !== undefined,
    top1FusedScore: top?.fusedScore ?? null,
    top2FusedScore: second?.fusedScore ?? null,
    fusedScoreGap: top && second ? Number((top.fusedScore - second.fusedScore).toFixed(8)) : null,
    top1QueryOverlap: top?.queryOverlap ?? 0,
    maxQueryOverlap: candidates.length
      ? Math.max(...candidates.map((candidate) => candidate.queryOverlap))
      : 0,
    uniqueDocumentCount: new Set(candidates.map((candidate) => candidate.documentTitle)).size,
    topDocumentResultCount: topDocumentCandidates.length,
    topDocumentShare: ratio(topDocumentCandidates.length, candidates.length),
    topDocumentDistinctSectionCount: distinctTopSections.size,
    dominantDocument: dominantDocumentGroup.key,
    dominantDocumentConcentration: ratio(dominantDocumentGroup.items.length, candidates.length),
    dominantSection: dominantSectionGroup.key,
    dominantSectionConcentration: ratio(dominantSectionGroup.items.length, candidates.length),
    supportingChunkCount: dominantDocumentGroup.items.filter(
      (candidate) => candidate.queryOverlap >= DEFAULT_SUPPORTING_CHUNK_OVERLAP,
    ).length,
    top1Top2DocumentAgreement:
      top !== undefined && second !== undefined && top.documentTitle === second.documentTitle,
    queryTokenCoverage: tokenCoverage(question, results, "all"),
    specificTokenCoverage: tokenCoverage(question, results, "specific"),
  };
}

function findExpectedDocumentRank(testCase: EvalCase, results: RetrievalResult[]): number | null {
  const expectedTitle = normalize(testCase.expected.documentTitle);
  if (!expectedTitle) return null;
  const index = results.findIndex((result) => normalize(result.document.title) === expectedTitle);
  return index >= 0 ? index + 1 : null;
}

function findExpectedSectionRank(testCase: EvalCase, results: RetrievalResult[]): number | null {
  const expectedTitle = normalize(testCase.expected.documentTitle);
  const sectionNeedle = normalize(testCase.expected.sectionContains);
  if (!expectedTitle || !sectionNeedle) return null;

  const index = results.findIndex(
    (result) =>
      normalize(result.document.title) === expectedTitle &&
      normalize(result.sectionPath).includes(sectionNeedle),
  );
  return index >= 0 ? index + 1 : null;
}

function classifyCase(testCase: EvalCase): CaseObservation["classification"] {
  if (testCase.expected.shouldHaveEvidence) return "positive";
  return testCase.expected.nearNegative ? "near_negative" : "far_negative";
}

function zeroEvidenceRate(observations: CaseObservation[]): number {
  return ratio(
    observations.filter((observation) => observation.retrievedResultCount === 0).length,
    observations.length,
  );
}

function irrelevantEvidenceRate(observations: CaseObservation[]): number {
  return ratio(
    observations.filter((observation) => observation.retrievedResultCount > 0).length,
    observations.length,
  );
}

function distribution(values: number[]): DistributionSummary {
  if (values.length === 0) {
    return { min: null, p25: null, median: null, p75: null, max: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: sorted[0],
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sortedValues: number[], quantile: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  const weight = index - lowerIndex;
  return round(sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight);
}

function specificityFor(
  decisions: Array<{ observation: CaseObservation; sufficient: boolean }>,
  classification: "far_negative" | "near_negative",
): number {
  const relevant = decisions.filter(
    ({ observation }) => observation.classification === classification,
  );
  return ratio(relevant.filter(({ sufficient }) => !sufficient).length, relevant.length);
}

function compositeSweepResult(
  strategyId: CompositeStrategyId,
  label: string,
  params: Record<string, number>,
  observations: CaseObservation[],
  sufficient: (observation: CaseObservation) => boolean,
): CompositeSweepResult {
  return {
    strategyId,
    label,
    params,
    metrics: calculateConfusionMetrics(
      observations.map((observation) => ({
        observation,
        decision: decision(strategyId, label, sufficient(observation), JSON.stringify(params)),
      })),
    ),
  };
}

function chooseBestCompositeCandidate(
  originalStrategies: StrategyComparison[],
  paraphraseStrategies: StrategyComparison[],
): StrategyComparison | null {
  const paraphrasesByStrategy = new Map(
    paraphraseStrategies.map((strategy) => [strategy.strategyId, strategy]),
  );
  const viable = originalStrategies.filter((strategy) => {
    const paraphrase = paraphrasesByStrategy.get(strategy.strategyId);
    return (
      strategy.metrics.recall === 1 &&
      strategy.metrics.falseNegative === 0 &&
      paraphrase?.metrics.recall === 1 &&
      paraphrase.metrics.falseNegative === 0
    );
  });
  if (viable.length === 0) return null;

  return [...viable].sort((left, right) => {
    const leftParaphrase = paraphrasesByStrategy.get(left.strategyId);
    const rightParaphrase = paraphrasesByStrategy.get(right.strategyId);
    return (
      left.metrics.nearNegativeFalsePositiveRate - right.metrics.nearNegativeFalsePositiveRate ||
      (leftParaphrase?.metrics.nearNegativeFalsePositiveRate ?? 1) -
        (rightParaphrase?.metrics.nearNegativeFalsePositiveRate ?? 1) ||
      right.metrics.specificity - left.metrics.specificity ||
      right.metrics.precision - left.metrics.precision ||
      left.strategyId.localeCompare(right.strategyId)
    );
  })[0];
}

function compareCompositeResults(left: CompositeSweepResult, right: CompositeSweepResult): number {
  return (
    right.metrics.recall - left.metrics.recall ||
    1 -
      right.metrics.nearNegativeFalsePositiveRate -
      (1 - left.metrics.nearNegativeFalsePositiveRate) ||
    right.metrics.specificity - left.metrics.specificity ||
    right.metrics.precision - left.metrics.precision ||
    left.metrics.falsePositive - right.metrics.falsePositive ||
    left.strategyId.localeCompare(right.strategyId)
  );
}

function signalDistributionFor(
  observations: CaseObservation[],
  classification: CaseObservation["classification"],
): CompositeSignalDistributions["positive"] {
  const matching = observations.filter(
    (observation) => observation.classification === classification,
  );
  return {
    maxLexicalOverlap: distribution(
      matching.map((observation) => observation.signals.maxQueryOverlap),
    ),
    topDocumentConcentration: distribution(
      matching.map((observation) => observation.signals.dominantDocumentConcentration),
    ),
    topSectionConcentration: distribution(
      matching.map((observation) => observation.signals.dominantSectionConcentration),
    ),
    supportingChunkCount: distribution(
      matching.map((observation) => observation.signals.supportingChunkCount),
    ),
    queryTokenCoverage: distribution(
      matching.map((observation) => observation.signals.queryTokenCoverage),
    ),
    specificTokenCoverage: distribution(
      matching.map((observation) => observation.signals.specificTokenCoverage),
    ),
  };
}

function largestGroup<T>(
  items: T[],
  keyFor: (item: T) => string,
): { key: string | null; items: T[] } {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  let best: { key: string | null; items: T[] } = { key: null, items: [] };
  for (const [key, groupItems] of groups.entries()) {
    if (
      groupItems.length > best.items.length ||
      (groupItems.length === best.items.length && key < (best.key ?? key))
    ) {
      best = { key, items: groupItems };
    }
  }
  return best;
}

function tokenCoverage(
  question: string,
  results: RetrievalResult[],
  mode: "all" | "specific",
): number {
  const queryTokens = mode === "all" ? tokenize(question) : specificTokens(question);
  if (queryTokens.length === 0) return 0;
  const evidenceTokens = new Set(
    tokenize(
      results
        .map((result) =>
          [result.document.title, result.sectionPath ?? "", result.content].join(" "),
        )
        .join(" "),
    ),
  );
  const hits = queryTokens.filter((token) => evidenceTokens.has(token)).length;
  return ratio(hits, queryTokens.length);
}

function queryOverlap(query: string, fields: string[]): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(fields.join(" ")));
  const hits = queryTokens.filter((token) => haystack.has(token)).length;
  return round(hits / queryTokens.length);
}

function specificTokens(value: string): string[] {
  return tokenize(value).filter((token) => token.length >= 6 || /\d/.test(token));
}

function tokenize(value: string): string[] {
  const normalized = normalize(value);
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length > 2 && !STOPWORDS.has(token)))];
}

function normalize(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function nullableString(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decision(
  strategyId: StrategyId | CompositeStrategyId,
  label: string,
  sufficient: boolean,
  reason: string,
): StrategyDecision {
  return { strategyId, label, sufficient, reason };
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return round(numerator / denominator);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function safeErrorPayload(response: Response): Promise<Record<string, unknown>> {
  try {
    return { status: response.status, payload: await response.json() };
  } catch {
    return { status: response.status, message: await response.text() };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function loadDotEnvLocal(path: string): RuntimeEnv {
  const env: RuntimeEnv = { ...process.env };
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function printSummary(artifact: BenchmarkArtifact): void {
  const summary = artifact.summary;
  const paraphrases = artifact.paraphraseSummary;
  console.log("Retrieval benchmark complete");
  console.log(`Fixture: ${artifact.fixturePath}`);
  console.log(
    `Cases: ${summary.totalCases} (${summary.positiveCases} positive, ${summary.farNegativeCases} far negative, ${summary.nearNegativeCases} near negative)`,
  );
  console.log(`Paraphrase fixture: ${artifact.paraphraseFixturePath}`);
  console.log(
    `Paraphrases: ${paraphrases.totalCases} (${paraphrases.positiveCases} positive, ${paraphrases.nearNegativeCases} near negative)`,
  );
  console.log(`Top-1 document accuracy: ${percent(summary.positiveTop1DocumentAccuracy)}`);
  console.log(`Top-3 document recall: ${percent(summary.positiveTop3DocumentRecall)}`);
  console.log(`Top-k document recall: ${percent(summary.positiveTopKDocumentRecall)}`);
  console.log(`Top-1 section accuracy: ${percent(summary.positiveTop1SectionAccuracy)}`);
  console.log(`Section hit within top-k: ${percent(summary.positiveSectionHitRate)}`);
  console.log(`Negative zero-evidence rate: ${percent(summary.negativeZeroEvidenceRate)}`);
  console.log(
    `Negative irrelevant-evidence rate: ${percent(summary.negativeIrrelevantEvidenceRate)}`,
  );
  console.log(`Near-negative zero-evidence rate: ${percent(summary.nearNegativeZeroEvidenceRate)}`);
  console.log(
    `Near-negative irrelevant-evidence rate: ${percent(summary.nearNegativeIrrelevantEvidenceRate)}`,
  );
  console.log(
    `Lexical max-overlap ranges: positive=${formatDistribution(artifact.lexicalOverlapDistributions.positiveMaxOverlap)}, far-negative=${formatDistribution(artifact.lexicalOverlapDistributions.farNegativeMaxOverlap)}, near-negative=${formatDistribution(artifact.lexicalOverlapDistributions.nearNegativeMaxOverlap)}`,
  );
  console.log(`OpenAI query embedding requests: ${artifact.openAIQueryEmbeddingRequests}`);
  console.log("Strategy comparison:");
  for (const strategy of artifact.strategyComparison) {
    const metrics = strategy.metrics;
    console.log(
      `- ${strategy.strategyId}: recall=${percent(metrics.recall)}, specificity=${percent(metrics.specificity)}, falsePositive=${metrics.falsePositive}, falseNegative=${metrics.falseNegative}`,
    );
  }
  console.log("Composite strategy comparison:");
  for (const strategy of artifact.compositeStrategyComparison) {
    const metrics = strategy.metrics;
    console.log(
      `- ${strategy.strategyId}: recall=${percent(metrics.recall)}, specificity=${percent(metrics.specificity)}, nearFP=${percent(metrics.nearNegativeFalsePositiveRate)}, falseNegative=${metrics.falseNegative}`,
    );
  }
  if (artifact.bestCompositeCandidate) {
    const metrics = artifact.bestCompositeCandidate.metrics;
    console.log(
      `Best composite candidate: ${artifact.bestCompositeCandidate.strategyId} (recall=${percent(metrics.recall)}, specificity=${percent(metrics.specificity)}, nearFP=${percent(metrics.nearNegativeFalsePositiveRate)})`,
    );
  } else {
    console.log("Best composite candidate: none preserving 100% original and paraphrase recall");
  }
  console.log(`Artifact: ${DEFAULT_OUTPUT_PATH}`);
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatDistribution(distributionSummary: DistributionSummary): string {
  if (distributionSummary.min === null) return "n/a";
  return `${distributionSummary.min}/${distributionSummary.p25}/${distributionSummary.median}/${distributionSummary.p75}/${distributionSummary.max}`;
}

const STOPWORDS = new Set([
  "aca",
  "ahi",
  "ante",
  "cada",
  "como",
  "con",
  "cual",
  "cuando",
  "dado",
  "del",
  "desde",
  "donde",
  "dos",
  "ell",
  "ella",
  "ellos",
  "entre",
  "esa",
  "ese",
  "eso",
  "esta",
  "este",
  "esto",
  "hacer",
  "hace",
  "hacen",
  "hacia",
  "hay",
  "las",
  "los",
  "mas",
  "para",
  "por",
  "que",
  "quien",
  "sin",
  "sobre",
  "sus",
  "una",
  "uno",
  "unos",
]);

async function main(): Promise<void> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const fixturePath = join(root, DEFAULT_FIXTURE_PATH);
  const paraphraseFixturePath = join(root, DEFAULT_PARAPHRASE_FIXTURE_PATH);
  const outputPath = join(root, DEFAULT_OUTPUT_PATH);
  const env = loadDotEnvLocal(join(root, ".env.local"));
  const artifact = await runRetrievalBenchmark({
    fixturePath,
    paraphraseFixturePath,
    outputPath,
    env,
  });
  printSummary(artifact);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
