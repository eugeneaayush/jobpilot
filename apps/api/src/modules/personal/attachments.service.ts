import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type PersonalAttachment,
  type PersonalAttachmentRequirements,
  type PersonalAttachmentReviewInput,
  personalAttachmentSchema,
} from "@jobpilot/contracts/personal-attachments";
import { singleton } from "tsyringe";
import { z } from "zod/v4";
import { conflict, notFound } from "@/common/errors";
import { type PersonalRecord, type Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  attachmentStatus,
  greenhouseAttachmentRequirements,
  observedAttachmentRequirements,
  postingContentHash,
  storedAttachments,
  storedRequirements,
} from "./attachments-policy";
import { generateCoverLetter } from "./document/cover-letter";
import {
  manifestHash,
  privateArtifactRoot,
  readPrivateArtifact,
  trustedRequisition,
} from "./persistence-policy";
import { PersonalService } from "./personal.service";
import { jsonValue, objectValue, sha256 } from "./runtime";
import { buildTailoringInput, type ReviewedProposal } from "./tailoring/proposal";

export async function fetchPublicJobQuestions(url: string, request: typeof fetch = fetch) {
  const response = await request(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok || !response.body)
    throw conflict(`Public job questions unavailable (${response.status})`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 1_000_000)
        throw conflict("Public job questions exceed the bounded response limit");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

@singleton()
export class PersonalAttachmentsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  async get(userId: string, recordId: string) {
    const record = await this.owned(this.prisma, userId, recordId);
    const inventory = await this.inventory(userId, record);
    return this.response(record, inventory);
  }

  async refresh(userId: string, recordId: string) {
    const record = await this.owned(this.prisma, userId, recordId);
    trustedRequisition(record);
    const posting = objectValue(objectValue(record.details).posting);
    const board = String(posting.boardToken);
    const nativeId = String(posting.nativeId);
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(board) || !/^[1-9][0-9]*$/.test(nativeId))
      throw conflict("Trusted Greenhouse board and numeric job identity required");
    const url = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${nativeId}?questions=true`;
    const bytes = await fetchPublicJobQuestions(url);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw conflict("Public job questions returned invalid JSON");
    }
    const requirements = greenhouseAttachmentRequirements(body, nativeId);
    const root = privateArtifactRoot(userId);
    const hash = sha256(bytes);
    const directory = join(root, "questions");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await chmod(directory, 0o700);
    const path = join(directory, `${hash}.json`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    if (sha256(await readPrivateArtifact(path, root)) !== hash)
      throw conflict("Frozen public question source changed");
    const inventory: PersonalAttachmentRequirements = {
      schemaVersion: 1,
      identity: record.identity,
      postingContentHash: postingContentHash(record),
      requirements,
      source: {
        kind: "greenhouse_questions",
        url,
        sha256: hash,
        path,
        capturedAt: new Date().toISOString(),
      },
    };
    const updated = await this.change(userId, recordId, (current) => {
      if (current.updatedAt.getTime() !== record.updatedAt.getTime())
        throw conflict("Record changed during requirements refresh");
      const details = objectValue(current.details);
      const history = Array.isArray(details.attachmentRequirementHistory)
        ? details.attachmentRequirementHistory
        : [];
      return {
        ...details,
        attachmentRequirements: inventory,
        attachmentRequirementHistory: [...history, inventory],
      };
    });
    return this.response(updated, inventory);
  }

  async coverLetter(userId: string, recordId: string, input: { fieldName: string }) {
    const record = await this.owned(this.prisma, userId, recordId);
    const inventory = await this.inventory(userId, record);
    const field = inventory?.requirements.find((entry) => entry.fieldName === input.fieldName);
    if (!inventory || field?.kind !== "cover_letter")
      throw conflict("Choose a cover-letter field from the saved employer questions");
    const { evidence, data } = await this.personal.resumeData(userId);
    const tailoring = objectValue(objectValue(record.details).tailoring);
    let reviewed: ReviewedProposal | undefined;
    if (Object.keys(tailoring).length) {
      if (tailoring.status !== "reviewed")
        throw conflict("Complete grounded tailoring review before generating its cover letter");
      reviewed = tailoring as unknown as ReviewedProposal;
      const fresh = buildTailoringInput(data, {
        sourceDigest: evidence.sourceHash,
        maxPages: reviewed.input.maxPages,
        job: {
          identity: record.identity,
          title: record.title,
          company: record.company,
          description: String(
            objectValue(objectValue(record.details).posting).descriptionText ?? "",
          ),
          postingContentHash: postingContentHash(record),
        },
      });
      if (fresh.inputHash !== reviewed.input.inputHash)
        throw conflict("Tailoring source facts or posting changed before cover-letter generation");
    }
    const generated = await generateCoverLetter(
      data,
      record,
      privateArtifactRoot(userId),
      reviewed,
    );
    const attachment: PersonalAttachment = {
      ...field,
      kind: "cover_letter",
      id: crypto.randomUUID(),
      identity: record.identity,
      postingContentHash: postingContentHash(record),
      path: generated.path,
      sha256: generated.sha256,
      bytes: generated.bytes,
      createdAt: new Date().toISOString(),
      source: {
        resumeEvidenceId: evidence.id,
        sourceHash: evidence.sourceHash,
        resumeDataHash: generated.resumeDataHash,
        citations: generated.citations,
      },
      review: null,
    };
    const updated = await this.change(userId, recordId, (current) => {
      if (current.updatedAt.getTime() !== record.updatedAt.getTime())
        throw conflict("Record changed during cover-letter generation");
      const details = objectValue(current.details);
      const documents = storedAttachments(details);
      const history = Array.isArray(details.attachmentHistory) ? details.attachmentHistory : [];
      return {
        ...details,
        attachmentRequirements: inventory,
        attachments: [
          ...documents.filter((entry) => entry.fieldName !== field.fieldName),
          attachment,
        ],
        attachmentHistory: [
          ...history,
          ...documents.filter((entry) => entry.fieldName === field.fieldName),
        ],
      };
    });
    return this.response(updated, inventory);
  }

  async review(userId: string, recordId: string, input: PersonalAttachmentReviewInput) {
    const updated = await this.change(userId, recordId, async (record) => {
      const details = objectValue(record.details);
      const documents = storedAttachments(details);
      const document = documents.find((entry) => entry.id === input.attachmentId);
      if (!document || document.sha256 !== input.pdfHash)
        throw conflict("Review belongs to a different attachment version");
      const bytes = await readPrivateArtifact(document.path, privateArtifactRoot(userId));
      if (sha256(bytes) !== document.sha256)
        throw conflict("Attachment PDF failed its integrity check");
      const { evidence, data } = await this.personal.resumeData(userId);
      if (
        evidence.id !== document.source.resumeEvidenceId ||
        evidence.sourceHash !== document.source.sourceHash ||
        manifestHash(data) !== document.source.resumeDataHash
      )
        throw conflict("Resume facts changed; regenerate this attachment before review");
      const inventory = await this.inventory(userId, record);
      if (
        !inventory ||
        document.identity !== record.identity ||
        document.postingContentHash !== postingContentHash(record) ||
        !inventory.requirements.some(
          (field) =>
            field.fieldName === document.fieldName &&
            field.label === document.label &&
            field.required === document.required &&
            field.kind === document.kind,
        )
      )
        throw conflict("Employer attachment requirements changed; regenerate this attachment");
      const review = {
        pdfHash: input.pdfHash,
        inspected: true as const,
        notes: input.notes,
        reviewedAt: new Date().toISOString(),
        reviewer: userId,
      };
      return {
        ...details,
        attachmentRequirements: inventory,
        attachments: documents.map((entry) =>
          entry.id === document.id ? { ...entry, review } : entry,
        ),
      };
    });
    return this.response(updated, storedRequirements(updated));
  }

  async pdf(userId: string, recordId: string, hash: string) {
    const record = await this.owned(this.prisma, userId, recordId);
    const details = objectValue(record.details);
    const history = z.array(personalAttachmentSchema).parse(details.attachmentHistory ?? []);
    const document = [...storedAttachments(details), ...history].find(
      (entry) => entry.sha256 === hash,
    );
    if (!document) throw notFound("Owned attachment version not found");
    const bytes = await readPrivateArtifact(document.path, privateArtifactRoot(userId));
    if (sha256(bytes) !== hash) throw conflict("Attachment PDF failed its integrity check");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": 'inline; filename="cover-letter.pdf"',
        "cache-control": "private, no-store",
      },
    });
  }

  private async inventory(userId: string, record: PersonalRecord) {
    const observed = await observedAttachmentRequirements(this.prisma, userId, record);
    const stored = storedRequirements(record);
    return observed && (!stored || observed.source.capturedAt > stored.source.capturedAt)
      ? observed
      : stored;
  }
  private async owned(
    db: Pick<Prisma.TransactionClient, "personalRecord">,
    userId: string,
    id: string,
  ) {
    const record = await db.personalRecord.findFirst({ where: { id, userId } });
    if (!record) throw notFound("Personal record not found");
    return record;
  }
  private change(
    userId: string,
    recordId: string,
    work: (record: PersonalRecord) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        const record = await this.owned(tx, userId, recordId);
        if (["applying", "submitted", "submission_uncertain"].includes(record.state))
          throw conflict("Stop or resolve the application before changing attachments");
        const active = await tx.personalAttempt.count({
          where: {
            userId,
            recordId,
            state: { in: ["preparing", "prepared", "submitting", "submission_uncertain"] },
          },
        });
        if (active)
          throw conflict("Stop or resolve the active attempt before changing attachments");
        const details = await work(record);
        const preview = objectValue(details.preview);
        const changed = await tx.personalRecord.updateMany({
          where: { id: recordId, userId, updatedAt: record.updatedAt },
          data: {
            details: jsonValue({
              ...details,
              ...(Object.keys(preview).length
                ? { preview: { ...preview, readiness: "draft", renderReviewed: false } }
                : {}),
            }),
          },
        });
        if (changed.count !== 1)
          throw conflict("Record changed while attachment evidence was being saved");
        return tx.personalRecord.findUniqueOrThrow({ where: { id: recordId } });
      },
      { timeout: 15000 },
    );
  }
  private response(record: PersonalRecord, inventory: PersonalAttachmentRequirements | null) {
    const documents = storedAttachments(record.details);
    const source = inventory?.source;
    const details = objectValue(record.details);
    return {
      recordId: record.id,
      updatedAt: record.updatedAt,
      requirements: inventory?.requirements ?? [],
      requirementsSource: source
        ? {
            kind: source.kind,
            sha256: source.sha256,
            capturedAt: new Date(source.capturedAt),
            ...(source.kind === "greenhouse_questions"
              ? { url: source.url }
              : { attemptId: source.attemptId }),
          }
        : null,
      documents: documents.map(({ path: _path, ...document }) => ({
        ...document,
        createdAt: new Date(document.createdAt),
        pdfUrl: `/api/personal/attachments/${record.id}/${document.sha256}/pdf`,
        review: document.review
          ? { ...document.review, reviewedAt: new Date(document.review.reviewedAt) }
          : null,
      })),
      ...attachmentStatus(inventory, documents),
      requiresPreview:
        objectValue(details.preview).renderReviewed !== true ||
        manifestHash(details.previewAttachments ?? null) !==
          manifestHash({ attachmentRequirements: inventory, attachments: documents }),
    };
  }
}
