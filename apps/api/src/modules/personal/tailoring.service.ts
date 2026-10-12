import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  personalTailoringResponseSchema,
  type personalTailoringReviewSchema,
} from "@jobpilot/contracts/personal-tailoring";
import { singleton } from "tsyringe";
import type { z } from "zod";
import { conflict, notFound } from "@/common/errors";
import { PrismaClient } from "@/generated/prisma/client";
import { postingContentHash } from "./attachments-policy";
import { resumePageLimit, seniorityParkReason } from "./graduate-policy";
import { PersonalService } from "./personal.service";
import {
  jsonValue,
  objectValue,
  personalConfiguration,
  personalRoot,
  savePrivate,
} from "./runtime";
import { runCodexTailoring } from "./tailoring/codex";
import {
  applyReviewedProposal,
  buildTailoringInput,
  type ReviewedProposal,
  tailoringHash,
} from "./tailoring/proposal";

@singleton()
export class PersonalTailoringService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly personal: PersonalService,
  ) {}

  protected generate(
    input: Parameters<typeof runCodexTailoring>[0],
    options: Parameters<typeof runCodexTailoring>[1],
  ) {
    return runCodexTailoring(input, options);
  }

  private async context(userId: string, recordId: string) {
    const record = await this.prisma.personalRecord.findFirst({ where: { id: recordId, userId } });
    if (!record) throw notFound("Record not found");
    const { evidence, data } = await this.personal.resumeData(userId);
    const posting = objectValue(objectValue(record.details).posting);
    const input = buildTailoringInput(data, {
      sourceDigest: evidence.sourceHash,
      maxPages: resumePageLimit(record),
      job: {
        identity: record.identity,
        title: record.title,
        company: record.company,
        description: String(posting.descriptionText ?? ""),
        postingContentHash: postingContentHash(record),
      },
    });
    return { record, data, input };
  }

  async get(userId: string, recordId: string) {
    const { record } = await this.context(userId, recordId);
    const saved = objectValue(objectValue(record.details).tailoring);
    return personalTailoringResponseSchema.parse({
      status: saved.status ?? "missing",
      reason: saved.reason ?? null,
      inputHash: objectValue(saved.input).inputHash ?? null,
      proposalHash: saved.proposal ? tailoringHash(saved.proposal) : null,
      input: saved.input ?? null,
      proposal: saved.proposal ?? null,
      review: saved.review ?? null,
    });
  }

  async propose(userId: string, recordId: string, signal?: AbortSignal) {
    const { record, input } = await this.context(userId, recordId);
    if (["applying", "submitted", "submission_uncertain"].includes(record.state))
      throw conflict("Active or possibly submitted documents are immutable");
    const level = seniorityParkReason(record);
    if (level) throw conflict(level);
    const config = await personalConfiguration(userId);
    const approval = objectValue(config.tailoringProvider);
    if (approval.provider !== "openai" || approval.allowApplicantData !== true) {
      const blocked = {
        status: "blocked",
        reason: "Approved OpenAI professional-fact tailoring is not configured",
        input,
      };
      const updated = await this.prisma.personalRecord.updateMany({
        where: {
          id: recordId,
          userId,
          updatedAt: record.updatedAt,
          details: { equals: jsonValue(record.details) },
          state: { notIn: ["applying", "submitted", "submission_uncertain"] },
        },
        data: { details: jsonValue({ ...objectValue(record.details), tailoring: blocked }) },
      });
      if (updated.count !== 1)
        throw conflict("Record changed while recording unavailable tailoring");
      return this.get(userId, recordId);
    }
    const details = objectValue(record.details);
    const previous = objectValue(details.tailoring);
    if (previous.status === "running" && Date.parse(String(previous.leaseExpiresAt)) > Date.now())
      throw conflict("A tailoring worker already owns this record");
    const claimId = crypto.randomUUID();
    const running = {
      status: "running",
      claimId,
      input,
      startedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 16 * 60_000).toISOString(),
    };
    const claim = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: record.updatedAt,
        details: { equals: jsonValue(record.details) },
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: { details: jsonValue({ ...details, tailoring: running }) },
    });
    if (claim.count !== 1) throw conflict("Record changed before tailoring reservation");
    const directory = path.join(personalRoot(), "storage", userId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const result = await this.generate(input, {
      runtimeDir: directory,
      privateRoot: personalRoot(),
      approval: { provider: "openai", allowApplicantData: true },
      signal,
    });
    const saved = { ...running, ...result };
    const current = await this.context(userId, recordId);
    if (current.input.inputHash !== input.inputHash) {
      const driftDetails = objectValue(current.record.details);
      if (objectValue(driftDetails.tailoring).claimId === claimId)
        await this.prisma.personalRecord.updateMany({
          where: {
            id: recordId,
            userId,
            updatedAt: current.record.updatedAt,
            details: { equals: jsonValue(current.record.details) },
            state: { notIn: ["applying", "submitted", "submission_uncertain"] },
          },
          data: {
            details: jsonValue({
              ...driftDetails,
              tailoring: {
                ...saved,
                status: "blocked",
                reason: "Source facts or posting changed; propose a fresh version",
              },
            }),
          },
        });
      throw conflict(
        "Source facts or posting changed during tailoring; proposal retained privately but not installed",
      );
    }
    const currentDetails = objectValue(current.record.details);
    if (
      objectValue(currentDetails.tailoring).claimId !== claimId ||
      ["applying", "submitted", "submission_uncertain"].includes(current.record.state)
    )
      throw conflict("Tailoring claim or application state changed; proposal remains private");
    const update = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: current.record.updatedAt,
        details: { equals: jsonValue(current.record.details) },
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: {
        details: jsonValue({ ...currentDetails, tailoring: saved, documentEdits: undefined }),
      },
    });
    if (update.count !== 1)
      throw conflict(
        "Record changed during tailoring; proposal retained privately but not installed",
      );
    return this.get(userId, recordId);
  }

  async review(
    userId: string,
    recordId: string,
    review: z.infer<typeof personalTailoringReviewSchema>,
    reviewer = userId,
  ) {
    const { record, data, input } = await this.context(userId, recordId);
    if (["applying", "submitted", "submission_uncertain"].includes(record.state))
      throw conflict("Active documents are immutable");
    const details = objectValue(record.details);
    const saved = objectValue(details.tailoring);
    if (saved.status !== "proposed" && saved.status !== "reviewed")
      throw conflict("No proposed tailoring is ready for review");
    if (objectValue(saved.input).inputHash !== input.inputHash)
      throw conflict("Tailoring sources changed; propose a fresh version");
    const reviewed = {
      input,
      proposal: saved.proposal,
      review: { ...review, reviewer, reviewedAt: new Date().toISOString() },
    } as ReviewedProposal;
    try {
      applyReviewedProposal(data, reviewed);
    } catch {
      throw conflict("Claim review is not grounded in this exact proposal and source packet");
    }
    const artifact = path.join(
      personalRoot(),
      "storage",
      userId,
      "tailoring",
      `review-${tailoringHash(reviewed)}.json`,
    );
    await savePrivate(artifact, reviewed);
    const changed = await this.prisma.personalRecord.updateMany({
      where: {
        id: recordId,
        userId,
        updatedAt: record.updatedAt,
        details: { equals: jsonValue(record.details) },
        state: { notIn: ["applying", "submitted", "submission_uncertain"] },
      },
      data: {
        details: jsonValue({
          ...details,
          tailoring: { ...saved, ...reviewed, status: "reviewed", reviewArtifact: artifact },
          preview: undefined,
          renderReview: undefined,
        }),
      },
    });
    if (changed.count !== 1) throw conflict("Record changed during tailoring review");
    return this.get(userId, recordId);
  }
}
