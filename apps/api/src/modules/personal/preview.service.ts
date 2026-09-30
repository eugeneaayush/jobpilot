import path from "node:path";
import { singleton } from "tsyringe";
import { conflict, notFound } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import {
  attachmentStatus,
  observedAttachmentRequirements,
  postingContentHash,
  storedAttachments,
  storedRequirements,
  verifyAttachmentManifest,
} from "./attachments-policy";
import { generateDraftPdf } from "./document";
import { buildFitEvaluation, campaignKeywords } from "./fit-evaluation";
import { resumePageLimit, seniorityParkReason } from "./graduate-policy";
import { verifyDocumentForUser } from "./local-tools/document-check";
import { documentPipelineMatches } from "./local-tools/pipeline-config";
import { verifyRendererMapping } from "./local-tools/renderer-mapping";
import {
  manifestHash as canonicalHash,
  privateArtifactRoot,
  readPrivateArtifact,
} from "./persistence-policy";
import { personalRecordDto } from "./personal.mapper";
import { PersonalService } from "./personal.service";
import { preparationPreviewHash } from "./preparation-policy";
import { jsonValue, objectValue, personalRoot, savePrivate, sha256, stringsValue } from "./runtime";
import { validateScreeningSnapshot } from "./screening-provenance";
import { buildTailoringInput, type ReviewedProposal } from "./tailoring/proposal";

@singleton()
export class PersonalPreviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  async verifyDocument(userId: string, recordId: string, signal?: AbortSignal) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const details = objectValue(record.details);
    const preview = objectValue(details.preview);
    const document = objectValue(details.document);
    const renderer = document.template;
    if (
      (renderer !== "cbs-letter-times" && renderer !== "rendercv-classic") ||
      !documentPipelineMatches(document, renderer)
    )
      throw conflict("Document renderer configuration changed; regenerate before review");
    await verifyRendererMapping(document, privateArtifactRoot(userId));
    const contact = objectValue(objectValue(document.data).basics);
    if (typeof contact.name !== "string" || !contact.name.trim())
      throw conflict("Accepted document contact evidence is missing");
    const bytes = new Uint8Array(await (await this.personal.pdf(userId, recordId)).arrayBuffer());
    if (sha256(bytes) !== preview.pdfHash) throw conflict("PDF changed before verification");
    const report = await verifyDocumentForUser(userId, bytes, {
      requiredText: [contact.name, contact.email, contact.phone].filter(
        (value): value is string => typeof value === "string" && !!value,
      ),
      supportedTerms: stringsValue(objectValue(details.fitEvaluation).supportedInDraft),
      maxPages: resumePageLimit(record),
      renderer,
      signal,
    });
    const changed = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: record.updatedAt,
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: {
        details: jsonValue({
          ...details,
          documentVerification: report,
          ...(report.status !== "passed"
            ? { preview: { ...preview, renderReviewed: false, readiness: "draft" } }
            : {}),
        }),
      },
    });
    if (changed.count !== 1) throw conflict("Record changed during document verification");
    if (report.status !== "passed")
      throw conflict("Document checks did not pass; inspect document verification and local tools");
    return report;
  }

  async review(
    userId: string,
    recordId: string,
    input: { pdfHash: string; inspected: true; notes: string },
  ) {
    const documentVerification = await this.verifyDocument(userId, recordId);
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const details = objectValue(record.details);
    const preview = objectValue(details.preview);
    if (preview.pdfHash !== input.pdfHash)
      throw conflict("Review belongs to a different PDF version");
    const inventory = storedRequirements(record);
    const attachments = storedAttachments(details);
    const frozenAttachments = { attachmentRequirements: inventory, attachments };
    if (canonicalHash(details.previewAttachments ?? null) !== canonicalHash(frozenAttachments))
      throw conflict("Attachments changed; generate a new preview before reviewing it");
    const { evidence, data } = await this.personal.resumeData(userId);
    await verifyAttachmentManifest(this.prisma, userId, record, frozenAttachments, false, {
      id: evidence.id,
      sourceHash: evidence.sourceHash,
      resumeDataHash: canonicalHash(data),
    });
    const attachmentsReady = attachmentStatus(inventory, attachments).readiness === "ready";
    const renderReview = { ...input, reviewedAt: new Date().toISOString(), reviewer: userId };
    const changed = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: record.updatedAt,
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: {
        details: jsonValue({
          ...details,
          renderReview,
          documentVerification,
          preview: {
            ...preview,
            renderReviewed: documentVerification.status === "passed",
            readiness:
              stringsValue(preview.conflicts).length === 0 &&
              attachmentsReady &&
              documentVerification.status === "passed"
                ? "ready"
                : "draft",
          },
        }),
      },
    });
    if (changed.count !== 1) throw conflict("Record changed during render review");
    if (documentVerification.status !== "passed")
      throw conflict("Document checks did not pass; inspect document verification and local tools");
    return this.personal.record(userId, recordId);
  }

  async form(userId: string, recordId: string): Promise<Response> {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const details = objectValue(record.details);
    const preview = objectValue(details.preview);
    if (!details.manifestPath) throw notFound("Generate an offline preview first");
    const bytes = await readPrivateArtifact(
      String(details.manifestPath),
      privateArtifactRoot(userId),
    );
    if (sha256(bytes) !== preview.manifestHash)
      throw conflict("Preview manifest failed its integrity check");
    const manifest = objectValue(JSON.parse(bytes.toString()));
    const escapeHtml = (value: unknown) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
    const answers = Array.isArray(manifest.answers) ? manifest.answers.map(objectValue) : [];
    const frozenAnswers = answers
      .map(
        (answer) =>
          `<dt>${escapeHtml(answer.label ?? answer.fieldName ?? answer.key)}</dt><dd>${escapeHtml(answer.value)}</dd>`,
      )
      .join("");
    const fields = stringsValue(manifest.missingAnswers)
      .map(
        (question) =>
          `<label>${escapeHtml(question)}<input disabled placeholder="Unknown — answer required" /></label>`,
      )
      .join("");
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"><title>Offline application preview</title><style>body{font:18px Georgia,serif;max-width:760px;margin:48px auto;padding:24px;line-height:1.5;color:#172536}label{display:block;margin:24px 0}input{display:block;width:95%;padding:12px}code{overflow-wrap:anywhere}aside{background:#eef3f7;padding:20px}</style><h1>Offline application preview</h1><aside>This local synthetic form makes no employer requests. No fields or files have been transmitted. There is no submit action.</aside><h2>${escapeHtml(record.title)}</h2><p>${escapeHtml(record.company)}</p><p>Document: ${escapeHtml(preview.readiness)} · Render inspected: ${preview.renderReviewed === true ? "yes" : "no"}</p><p>Frozen PDF SHA256<br><code>${escapeHtml(preview.pdfHash)}</code></p><h3>Frozen screening answers</h3><dl>${frozenAnswers || "No screening answers have been supplied."}</dl><form><fieldset disabled><legend>Required information still unknown</legend>${fields || "No required answers are listed in this frozen snapshot. Live employer form validation remains pending."}</fieldset></form><h3>Source conflicts</h3><ul>${stringsValue(
      preview.conflicts,
    )
      .map((value) => `<li>${escapeHtml(value)}</li>`)
      .join(
        "",
      )}</ul><p>Preview manifest SHA256<br><code>${escapeHtml(preview.manifestHash)}</code></p></html>`;
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async preview(userId: string, recordId: string, signal?: AbortSignal) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    if (["applying", "submitted", "submission_uncertain"].includes(record.state))
      throw conflict("Cannot replace documents on an active or possibly submitted application");
    const { evidence, resume, data } = await this.personal.resumeData(userId);
    const details = objectValue(record.details);
    const conflicts = stringsValue(objectValue(evidence.details).conflicts);
    const levelReason = seniorityParkReason(record);
    if (levelReason) conflicts.push(levelReason);
    const observed = await observedAttachmentRequirements(this.prisma, userId, record);
    const savedRequirements = storedRequirements(record);
    const attachmentRequirements =
      observed &&
      (!savedRequirements || observed.source.capturedAt > savedRequirements.source.capturedAt)
        ? observed
        : savedRequirements;
    const attachments = storedAttachments(details);
    const previewAttachments = { attachmentRequirements, attachments };
    const savedTailoring = objectValue(details.tailoring);
    if (savedTailoring.status && savedTailoring.status !== "reviewed")
      throw conflict(
        "Requested full-description tailoring must be reviewed before preview; no extractive fallback was substituted",
      );
    let reviewedProposal: ReviewedProposal | undefined;
    const maxPages = resumePageLimit(record);
    const posting = objectValue(details.posting);
    if (savedTailoring.status === "reviewed") {
      const input = buildTailoringInput(data, {
        sourceDigest: evidence.sourceHash,
        maxPages,
        job: {
          identity: record.identity,
          title: record.title,
          company: record.company,
          description: String(posting.descriptionText ?? ""),
          postingContentHash: postingContentHash(record),
        },
      });
      if (objectValue(savedTailoring.input).inputHash !== input.inputHash)
        throw conflict("Reviewed tailoring is stale; regenerate against current facts and posting");
      reviewedProposal = {
        input,
        proposal: savedTailoring.proposal,
        review: savedTailoring.review,
      } as ReviewedProposal;
    }
    const settings = await this.personal.settings(userId);
    const document = await generateDraftPdf(data, path.join(personalRoot(), "storage", userId), {
      renderer: settings.resumeRenderer ?? "cbs-letter-times",
      userId,
      jobKeywords: `${record.title} ${String(posting.descriptionText ?? "")}`
        .split(/\W+/)
        .filter((word) => word.length > 3),
      reviewedProposal,
      requestedMode:
        reviewedProposal && reviewedProposal.proposal.rewrites.length > 0
          ? "rewrite"
          : "extractive",
      documentEdits: details.documentEdits,
      maxPages,
      conflicts,
      sourceDigest: evidence.sourceHash,
      signal,
    });
    const fitEvaluation = buildFitEvaluation(
      {
        title: record.title,
        employer: record.company,
        descriptionText: String(posting.descriptionText ?? ""),
        location: typeof posting.location === "string" ? posting.location : null,
        deadline: typeof posting.deadline === "string" ? posting.deadline : null,
      },
      {
        keywords: campaignKeywords(data, settings),
        preferredLocations: settings.locations,
        restrictedEmployers: settings.exclusions,
        ...(settings.minimumCompensation !== null &&
        settings.compensationCurrency &&
        settings.compensationPeriod
          ? {
              minimumCompensation: {
                amount: settings.minimumCompensation,
                currency: settings.compensationCurrency,
                period: settings.compensationPeriod,
              },
            }
          : {}),
      },
      data,
      document.data,
    );
    conflicts.push(
      ...document.conflicts.filter(
        (value): value is string => typeof value === "string" && !conflicts.includes(value),
      ),
    );
    if (document.pageLimitExceeded) conflicts.push(`Resume exceeds its ${maxPages}-page limit`);
    const screeningSnapshot = validateScreeningSnapshot(record, settings, evidence);
    const manifest = {
      recordId,
      identity: record.identity,
      postingContentHash: postingContentHash(record),
      url: record.url,
      resumeEvidenceId: evidence.id,
      resumeId: resume.id,
      sourceHash: evidence.sourceHash,
      document: { path: document.path, sha256: document.sha256 },
      ...previewAttachments,
      answers: screeningSnapshot?.answers ?? [],
      screeningAnswerSnapshot: screeningSnapshot,
      screeningAnswerSnapshotHash: screeningSnapshot?.snapshotHash ?? null,
      previewMode: "offline",
      missingAnswers: stringsValue(details.missingAnswers),
      createdAt: new Date().toISOString(),
    };
    const manifestHash = sha256(JSON.stringify(manifest, null, 2));
    const manifestPath = path.join(
      personalRoot(),
      "storage",
      userId,
      "previews",
      `${manifestHash}.json`,
    );
    await savePrivate(manifestPath, manifest);
    const preview = {
      mode: "offline",
      pdfUrl: `/api/personal/${record.id}/pdf`,
      pdfHash: document.sha256,
      manifestHash,
      readiness: "draft",
      conflicts,
      renderReviewed: false,
      preparationContextHash: preparationPreviewHash(
        { ...record, details: { ...details, attachmentRequirements } as typeof record.details },
        settings,
        evidence,
        data,
      ),
    };
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.personalRecord.updateMany({
        where: {
          id: record.id,
          userId,
          updatedAt: record.updatedAt,
          state: { notIn: ["applying", "submitted", "submission_uncertain"] },
        },
        data: {
          details: jsonValue({
            ...details,
            preview,
            document,
            fitEvaluation,
            documentVerification: null,
            manifestPath,
            attachmentRequirements,
            previewAttachments,
            previewHistory: [
              ...(Array.isArray(details.previewHistory) ? details.previewHistory : []),
              ...(details.preview && details.document && details.manifestPath
                ? [
                    {
                      preview: details.preview,
                      document: details.document,
                      manifestPath: details.manifestPath,
                      renderReview: details.renderReview ?? null,
                      attachments: details.previewAttachments ?? null,
                    },
                  ]
                : []),
            ],
          }),
          state: "prepared",
        },
      });
      if (changed.count !== 1)
        throw conflict("Record changed during preparation; inspect it before retrying");
      return tx.personalRecord.findUniqueOrThrow({ where: { id: record.id } });
    });
    return personalRecordDto(updated, { settings, evidence });
  }
}
