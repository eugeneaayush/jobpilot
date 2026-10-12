import {
  addCampaignNetworkingSchema,
  isTerminalNetworkingStatus,
  networkingConfigSchema,
  networkingMessageResultSchema,
  networkingModeSchema,
  patchNetworkingMessageSchema,
  sendEmailSchema,
} from "./networking";
import { describe, expect, it } from "bun:test";

const UUID = "3f2c3f1e-0d5c-4f6a-9b8e-1a2b3c4d5e6f";

describe("networkingModeSchema", () => {
  it("requires a known channel and autonomy level", () => {
    expect(networkingModeSchema.safeParse({ channel: "email", autonomy: "auto" }).success).toBe(
      true,
    );
    expect(networkingModeSchema.safeParse({ channel: "sms", autonomy: "auto" }).success).toBe(
      false,
    );
    expect(networkingModeSchema.safeParse({ channel: "email", autonomy: "yolo" }).success).toBe(
      false,
    );
  });
});

describe("networkingConfigSchema", () => {
  it("needs at least one channel and defaults autonomy to draft", () => {
    expect(networkingConfigSchema.parse({ channels: ["email"] })).toEqual({
      channels: ["email"],
      autonomy: "draft",
    });
    expect(networkingConfigSchema.safeParse({ channels: [] }).success).toBe(false);
  });

  it("bounds dailyCap to a whole number from 1 to 100", () => {
    const withCap = (dailyCap: number) => ({ channels: ["email"], dailyCap });
    expect(networkingConfigSchema.safeParse(withCap(1)).success).toBe(true);
    expect(networkingConfigSchema.safeParse(withCap(100)).success).toBe(true);
    expect(networkingConfigSchema.safeParse(withCap(0)).success).toBe(false);
    expect(networkingConfigSchema.safeParse(withCap(101)).success).toBe(false);
    expect(networkingConfigSchema.safeParse(withCap(1.5)).success).toBe(false);
  });

  it("rejects an unknown LinkedIn tier", () => {
    expect(
      networkingConfigSchema.safeParse({ channels: ["linkedin"], linkedinTier: "premium" }).success,
    ).toBe(true);
    expect(
      networkingConfigSchema.safeParse({ channels: ["linkedin"], linkedinTier: "pro" }).success,
    ).toBe(false);
  });
});

describe("isTerminalNetworkingStatus", () => {
  it("locks the five terminal statuses and nothing else", () => {
    for (const status of ["sent", "replied", "bounced", "failed", "skipped"]) {
      expect(isTerminalNetworkingStatus(status)).toBe(true);
    }
    for (const status of ["draft", "approved", "anything-else"]) {
      expect(isTerminalNetworkingStatus(status)).toBe(false);
    }
  });
});

describe("addCampaignNetworkingSchema", () => {
  it("requires either contactId or contact, naming the pair in the error", () => {
    const neither = addCampaignNetworkingSchema.safeParse({ message: { channel: "email" } });
    expect(neither.success).toBe(false);
    if (!neither.success) {
      expect(neither.error.issues[0].message).toBe("Provide either contactId or contact.");
    }
    expect(
      addCampaignNetworkingSchema.safeParse({ contactId: UUID, message: { channel: "email" } })
        .success,
    ).toBe(true);
  });

  it("defaults the draft body to empty and cleans replacement chars in free text", () => {
    const added = addCampaignNetworkingSchema.parse({
      contact: { name: "Grace Hopper" },
      message: { channel: "email", subject: `Great${String.fromCharCode(0xfffd)}talk` },
    });
    expect(added.message.body).toBe("");
    expect(added.message.subject).toBe("Great-talk");
  });

  it("validates the contact fields it accepts", () => {
    const badContact = (contact: Record<string, unknown>) =>
      addCampaignNetworkingSchema.safeParse({ contact, message: { channel: "email" } }).success;
    expect(badContact({})).toBe(false);
    expect(badContact({ name: "G" })).toBe(true);
    expect(badContact({ name: "G", email: "nope" })).toBe(false);
    expect(badContact({ name: "G", emailConfidence: 1.5 })).toBe(false);
    expect(badContact({ name: "G", emailSource: "rumor" })).toBe(false);
    expect(badContact({ name: "G", linkedinConnection: "follower" })).toBe(false);
  });

  it("restricts a new message to draft or approved", () => {
    expect(
      addCampaignNetworkingSchema.safeParse({
        contact: { name: "G" },
        message: { channel: "email", status: "approved" },
      }).success,
    ).toBe(true);
    expect(
      addCampaignNetworkingSchema.safeParse({
        contact: { name: "G" },
        message: { channel: "email", status: "sent" },
      }).success,
    ).toBe(false);
  });
});

describe("patchNetworkingMessageSchema", () => {
  it("allows every field to be omitted but holds the line at terminal statuses", () => {
    expect(patchNetworkingMessageSchema.parse({})).toEqual({});
    expect(patchNetworkingMessageSchema.safeParse({ status: "sent" }).success).toBe(false);
    expect(
      patchNetworkingMessageSchema.safeParse({ contactLinkedinConnection: "connected" }).success,
    ).toBe(true);
    expect(
      patchNetworkingMessageSchema.safeParse({ contactLinkedinConnection: "follower" }).success,
    ).toBe(false);
  });
});

describe("networkingMessageResultSchema", () => {
  it("requires failReason only when the outcome is failed", () => {
    const failed = networkingMessageResultSchema.safeParse({ outcome: "failed" });
    expect(failed.success).toBe(false);
    if (!failed.success) {
      expect(failed.error.issues[0].message).toBe("failed requires failReason.");
    }
    const emptyReason = networkingMessageResultSchema.safeParse({
      outcome: "failed",
      failReason: "",
    });
    expect(emptyReason.success).toBe(false);
    expect(emptyReason.error?.issues.map((issue) => issue.message)).toContain(
      "failed requires failReason.",
    );
    expect(
      networkingMessageResultSchema.safeParse({ outcome: "failed", failReason: "bounce" }).success,
    ).toBe(true);
    expect(networkingMessageResultSchema.safeParse({ outcome: "sent" }).success).toBe(true);
  });

  it("rejects an outcome outside sent/failed/skipped, a non-ISO sentAt, and an empty failReason", () => {
    expect(networkingMessageResultSchema.safeParse({ outcome: "replied" }).success).toBe(false);
    expect(
      networkingMessageResultSchema.safeParse({ outcome: "sent", sentAt: "2026-01-02" }).success,
    ).toBe(false);
    expect(
      networkingMessageResultSchema.safeParse({ outcome: "sent", sentAt: "2026-01-02T03:04:05Z" })
        .success,
    ).toBe(true);
    // "sent" so the failed-needs-a-reason refine cannot be what rejects the empty string.
    const emptyReason = networkingMessageResultSchema.safeParse({
      outcome: "sent",
      failReason: "",
    });
    expect(emptyReason.success).toBe(false);
    expect(emptyReason.error?.issues.map((issue) => issue.path)).toEqual([["failReason"]]);
  });
});

describe("sendEmailSchema", () => {
  it("requires an address and defaults subject and body to empty", () => {
    expect(sendEmailSchema.parse({ to: "boss@example.com" })).toEqual({
      to: "boss@example.com",
      subject: "",
      body: "",
    });
    expect(sendEmailSchema.safeParse({ to: "not-an-email" }).success).toBe(false);
  });

  it("requires every attachment part to be non-empty", () => {
    const attachment = {
      filename: "resume.pdf",
      mimeType: "application/pdf",
      contentBase64: "QUJD",
    };
    expect(
      sendEmailSchema.safeParse({ to: "boss@example.com", attachments: [attachment] }).success,
    ).toBe(true);
    expect(
      sendEmailSchema.safeParse({
        to: "boss@example.com",
        attachments: [{ ...attachment, filename: "" }],
      }).success,
    ).toBe(false);
  });
});
