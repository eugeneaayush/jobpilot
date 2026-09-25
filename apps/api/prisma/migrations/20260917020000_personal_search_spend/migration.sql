CREATE TYPE "personal_spend_category" AS ENUM ('search', 'tailoring', 'other');
CREATE TYPE "personal_spend_status" AS ENUM ('reserved', 'completed', 'blocked', 'failed', 'uncertain');

CREATE TABLE "personal_spend_reservations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "category" "personal_spend_category" NOT NULL,
    "status" "personal_spend_status" NOT NULL DEFAULT 'reserved',
    "amount_microusd" INTEGER NOT NULL,
    "policy_month" TEXT NOT NULL,
    "policy_timezone" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "reserved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "next_eligible_at" TIMESTAMP(3),
    "receipt" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "personal_spend_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "personal_spend_amount_positive" CHECK ("amount_microusd" > 0),
    CONSTRAINT "personal_spend_request_hash" CHECK ("request_hash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "personal_spend_reservations_user_id_reserved_at_idx" ON "personal_spend_reservations"("user_id", "reserved_at");
CREATE INDEX "personal_spend_reservations_user_id_provider_next_eligible_at_idx" ON "personal_spend_reservations"("user_id", "provider", "next_eligible_at");
ALTER TABLE "personal_spend_reservations" ADD CONSTRAINT "personal_spend_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
