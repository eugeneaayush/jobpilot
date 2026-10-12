import type { PersonalSettings } from "@jobpilot/contracts/personal";
import type { PersonalFitEvaluation } from "@jobpilot/contracts/personal-fit";
import type { ResumeData } from "@jobpilot/contracts/resume";
import type { CampaignPrefs } from "./evaluation";
import { manifestHash } from "./persistence-policy";

export function campaignKeywords(
  data: ResumeData,
  settings: Pick<PersonalSettings, "targetFunctions">,
) {
  const sourceSkills = data.sections.flatMap((section) =>
    section.entries
      .filter((entry) => /^skills$/i.test(entry.heading))
      .flatMap((entry) =>
        [entry.subheading ?? "", ...entry.bullets].flatMap((text) =>
          text
            .split(/[,;]/)
            .map((term) => term.trim())
            .filter(Boolean),
        ),
      ),
  );
  return [
    ...new Set([
      ...settings.targetFunctions,
      ...data.skills.flatMap((group) => group.items),
      ...sourceSkills,
    ]),
  ];
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{Pd}\s]+/gu, " ")
    .trim();
}

export function normalizedTerms(terms: string[]): string[] {
  return [...new Set(terms.map(normalize).filter(Boolean))];
}

export function containsTerm(text: string, term: string): boolean {
  const normalized = normalize(term);
  if (!normalized) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}+#])${escaped}(?=$|[^\\p{L}\\p{N}+#])`, "u").test(
    normalize(text),
  );
}

function resumeContentText(resume: ResumeData): string {
  return [
    resume.basics.name,
    resume.basics.headline,
    resume.basics.location,
    resume.summary,
    ...resume.experience.flatMap(({ company, title, location, start, end, bullets }) => [
      company,
      title,
      location,
      start,
      end,
      ...bullets,
    ]),
    ...resume.projects.flatMap(({ name, description, bullets, keywords, start, end }) => [
      name,
      description,
      ...bullets,
      ...keywords,
      start,
      end,
    ]),
    ...resume.skills.flatMap(({ group, items }) => [group, ...items]),
    ...resume.education.flatMap(({ school, degree, start, end, details }) => [
      school,
      degree,
      start,
      end,
      ...details,
    ]),
    ...resume.publications.flatMap(({ title, authors, venue, year }) => [
      title,
      authors,
      venue,
      year,
    ]),
    ...resume.awards.flatMap(({ title, issuer, year, description }) => [
      title,
      issuer,
      year,
      description,
    ]),
    ...resume.certifications.flatMap(({ name, issuer, issued, expires }) => [
      name,
      issuer,
      issued,
      expires,
    ]),
    ...resume.sections.flatMap(({ title, entries }) => [
      title,
      ...entries.flatMap(({ heading, subheading, meta, bullets }) => [
        heading,
        subheading,
        meta,
        ...bullets,
      ]),
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function buildFitEvaluation(
  posting: {
    title: string;
    descriptionText: string;
    employer: string;
    location: string | null;
    deadline?: string | null;
  },
  prefs: CampaignPrefs,
  base: ResumeData,
  draft?: ResumeData,
): PersonalFitEvaluation {
  const requested = normalizedTerms(prefs.keywords ?? []);
  const postingTerms = requested.filter((term) =>
    containsTerm(`${posting.title}\n${posting.descriptionText}`, term),
  );
  const corpus = resumeContentText(base);
  const supportedByBase = postingTerms.filter((term) => containsTerm(corpus, term));
  const draftText = draft ? resumeContentText(draft) : null;
  const insufficientEvidence: PersonalFitEvaluation["insufficientEvidence"] = [];
  if (!posting.descriptionText.trim()) insufficientEvidence.push("posting_description_missing");
  if (!requested.length) insufficientEvidence.push("no_campaign_terms");
  else if (!postingTerms.length) insufficientEvidence.push("no_posting_terms");
  if (!draft) insufficientEvidence.push("draft_not_provided");
  return {
    version: "whole-term-v1",
    postingHash: manifestHash({
      title: posting.title,
      descriptionText: posting.descriptionText,
      employer: posting.employer,
      location: posting.location,
      deadline: posting.deadline ?? null,
    }),
    resumeHash: manifestHash(base),
    campaignInputsHash: manifestHash({
      keywords: requested,
      preferredLocations: prefs.preferredLocations ?? [],
      minimumCompensation: prefs.minimumCompensation ?? null,
      restrictedEmployers: prefs.restrictedEmployers ?? [],
    }),
    draftHash: draft ? manifestHash(draft) : null,
    postingTerms,
    supportedByBase,
    supportedInDraft:
      draftText === null ? [] : supportedByBase.filter((term) => containsTerm(draftText, term)),
    supportedButOmitted:
      draftText === null ? [] : supportedByBase.filter((term) => !containsTerm(draftText, term)),
    absentFromBase: postingTerms.filter((term) => !supportedByBase.includes(term)),
    insufficientEvidence,
  };
}
