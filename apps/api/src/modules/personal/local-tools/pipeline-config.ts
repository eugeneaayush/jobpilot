import rendererPackage from "@react-pdf/renderer/package.json";
import { localToolSourceHash } from "../yaml.structure";

type Renderer = "cbs-letter-times" | "rendercv-classic" | "cbs-cover-letter";
const RENDERCV_CONFIG = {
  renderer: "rendercv-classic",
  design: {
    theme: "classic",
    page: { size: "us-letter", show_footer: false, show_top_note: false },
  },
  version: "2.8",
  mappingVersion: 1,
  typstVersion: "0.15.0",
  fontsVersion: "0.5.1",
  fontFamilies: ["Source Sans 3", "Font Awesome 7", "Noto Sans"],
};
const CBS_CONFIG = {
  renderer: "cbs-letter-times",
  templateRevision: "1",
  rendererVersion: rendererPackage.version,
  pageSize: "LETTER",
  fontFamily: "Times-Roman",
  bodyFontSize: 10,
  nameFontSize: 15,
  horizontalPadding: 39.6,
  verticalPadding: 31,
  lineHeight: 1.02,
};
const COVER_LETTER_CONFIG = {
  renderer: "cbs-cover-letter",
  templateRevision: "1",
  rendererVersion: rendererPackage.version,
  pageSize: "LETTER",
  fontFamily: "Times-Roman",
  fontSize: 11,
  padding: 54,
  lineHeight: 1.35,
  paragraphMarginBottom: 14,
  contactHeaderRevision: "1",
};

export function documentPipelineInputs(renderer: Renderer) {
  let config: object = CBS_CONFIG;
  if (renderer === "rendercv-classic") config = RENDERCV_CONFIG;
  if (renderer === "cbs-cover-letter") config = COVER_LETTER_CONFIG;
  return {
    documentPipelineVersion: "private-documents-v3",
    renderer,
    rendererVersion:
      renderer === "rendercv-classic" ? RENDERCV_CONFIG.version : CBS_CONFIG.rendererVersion,
    rendererConfigHash: localToolSourceHash(config),
    verifierVersion: "1" as const,
    verifierConfigHash: localToolSourceHash({
      version: "1",
      pypdfVersion: "6.7.5",
      textMinimumCharacters: 60,
      pageLimits: [1, 2],
      bboxEngine: "poppler-pdftotext",
      horizontalGlyphTolerance: 5,
      verticalGlyphTolerance: 12,
      cbsPageFooter: { fontSize: 7, bottom: 12, right: 39.6, regionWidth: 100, regionHeight: 25 },
      rendererMargins: {
        "cbs-letter-times": [39.6, 31],
        "cbs-cover-letter": [54, 54],
        "rendercv-classic": [50.4, 50.4],
      },
    }),
  };
}

export function documentPipelineMatches(value: unknown, renderer: Renderer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  return Object.entries(documentPipelineInputs(renderer)).every(
    ([key, expected]) =>
      (key === "renderer" ? (document.template ?? document.renderer) : document[key]) === expected,
  );
}

export function verifierPipelineMatches(value: unknown, renderer: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!["cbs-letter-times", "rendercv-classic", "cbs-cover-letter"].includes(renderer))
    return false;
  const report = value as Record<string, unknown>;
  const expected = documentPipelineInputs(renderer as Renderer);
  return (
    report.renderer === renderer &&
    report.verifierVersion === expected.verifierVersion &&
    report.verifierConfigHash === expected.verifierConfigHash
  );
}

export function assertRendererConfiguration(
  renderer: Renderer,
  result: { rendererVersion: string; configSha256: string },
) {
  const expected = documentPipelineInputs(renderer);
  if (
    result.rendererVersion !== expected.rendererVersion ||
    result.configSha256 !== expected.rendererConfigHash
  )
    throw new Error(
      "Renderer configuration differs from the approved document pipeline; install the locked tools and regenerate preparation",
    );
}
