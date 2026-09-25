-- CreateEnum
CREATE TYPE "personal_track" AS ENUM ('mba_internship', 'post_mba_fulltime', 'general_professional');

-- CreateEnum
CREATE TYPE "personal_record_state" AS ENUM ('discovered', 'eligible', 'prepared', 'applying', 'submitted', 'blocked', 'failed', 'submission_uncertain');

-- CreateEnum
CREATE TYPE "personal_discovery_status" AS ENUM ('complete', 'partial', 'failed', 'blocked');

-- CreateEnum
CREATE TYPE "personal_attempt_mode" AS ENUM ('offline', 'live_preview', 'submit');

-- CreateEnum
CREATE TYPE "personal_attempt_state" AS ENUM ('preparing', 'prepared', 'submitting', 'submitted', 'blocked', 'failed', 'submission_uncertain', 'cancelled');

-- CreateTable
CREATE TABLE "personal_records" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "job_id" TEXT,
    "identity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "requisition_id" TEXT,
    "track" "personal_track" NOT NULL,
    "state" "personal_record_state" NOT NULL DEFAULT 'discovered',
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_discovery_runs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "personal_discovery_status" NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_discovery_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_resume_evidence" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "source_hash" TEXT NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_resume_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_attempts" (
    "id" TEXT NOT NULL,
    "record_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "mode" "personal_attempt_mode" NOT NULL,
    "state" "personal_attempt_state" NOT NULL DEFAULT 'preparing',
    "manifest" JSONB NOT NULL,
    "manifest_hash" TEXT NOT NULL,
    "lease_owner" TEXT NOT NULL,
    "lease_generation" INTEGER NOT NULL DEFAULT 1,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "submit_at" TIMESTAMP(3),
    "receipt" JSONB,
    "attempt_no" INTEGER NOT NULL,
    "policy_day" TEXT NOT NULL,

    CONSTRAINT "personal_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_reservations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "personal_records_user_id_created_at_idx" ON "personal_records"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "personal_records_user_id_identity_key" ON "personal_records"("user_id", "identity");

-- CreateIndex
CREATE INDEX "personal_discovery_runs_user_id_created_at_idx" ON "personal_discovery_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "personal_resume_evidence_user_id_resume_id_idx" ON "personal_resume_evidence"("user_id", "resume_id");

-- CreateIndex
CREATE INDEX "personal_attempts_user_id_policy_day_state_idx" ON "personal_attempts"("user_id", "policy_day", "state");

-- CreateIndex
CREATE INDEX "personal_attempts_user_id_campaign_id_state_idx" ON "personal_attempts"("user_id", "campaign_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "personal_attempts_record_id_attempt_no_key" ON "personal_attempts"("record_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "personal_reservations_attempt_id_key" ON "personal_reservations"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "personal_reservations_user_id_identity_key" ON "personal_reservations"("user_id", "identity");

-- CreateIndex
CREATE UNIQUE INDEX "personal_reservations_user_id_url_key" ON "personal_reservations"("user_id", "url");

-- AddForeignKey
ALTER TABLE "personal_records" ADD CONSTRAINT "personal_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_discovery_runs" ADD CONSTRAINT "personal_discovery_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_resume_evidence" ADD CONSTRAINT "personal_resume_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_attempts" ADD CONSTRAINT "personal_attempts_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "personal_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_attempts" ADD CONSTRAINT "personal_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_reservations" ADD CONSTRAINT "personal_reservations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_reservations" ADD CONSTRAINT "personal_reservations_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "personal_attempts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A manifest is an append-only authority snapshot, including when written outside the broker.
CREATE FUNCTION personal_attempt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.record_id IS DISTINCT FROM OLD.record_id
    OR NEW.campaign_id IS DISTINCT FROM OLD.campaign_id OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no OR NEW.policy_day IS DISTINCT FROM OLD.policy_day THEN
    RAISE EXCEPTION 'Personal attempt authority fields are immutable';
  END IF;
  IF OLD.submit_at IS NOT NULL AND NEW.submit_at IS DISTINCT FROM OLD.submit_at THEN
    RAISE EXCEPTION 'The submit boundary cannot be cleared or moved';
  END IF;
  IF OLD.state = 'submitted' AND NEW.state <> 'submitted' THEN
    RAISE EXCEPTION 'A confirmed submission is permanent';
  END IF;
  IF OLD.state IN ('submitting', 'submission_uncertain') AND NEW.state NOT IN ('submitting', 'submission_uncertain', 'submitted') THEN
    IF NEW.state <> 'cancelled' OR NEW.receipt->>'outcome' IS DISTINCT FROM 'not_submitted'
      OR NEW.receipt->>'manifestHash' IS DISTINCT FROM OLD.manifest_hash THEN
      RAISE EXCEPTION 'An unresolved submission requires non-submission evidence before release';
    END IF;
  END IF;
  IF NEW.state IN ('submitting', 'submission_uncertain', 'submitted') AND (NEW.mode <> 'submit' OR NEW.submit_at IS NULL) THEN
    RAISE EXCEPTION 'Submission states require a submit-mode boundary';
  END IF;
  IF NEW.state = 'submitted' AND (NEW.receipt->>'outcome' IS DISTINCT FROM 'submitted'
    OR NEW.receipt->>'manifestHash' IS DISTINCT FROM NEW.manifest_hash) THEN
    RAISE EXCEPTION 'A confirmed submission requires a matching receipt';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER personal_attempt_immutable BEFORE UPDATE ON personal_attempts
FOR EACH ROW EXECUTE FUNCTION personal_attempt_immutable();

-- Timeouts and accidental cleanup cannot erase an unresolved or completed submission reservation.
CREATE FUNCTION personal_reservation_preserve() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt_state personal_attempt_state;
BEGIN
  SELECT state INTO attempt_state FROM personal_attempts WHERE id = OLD.attempt_id;
  IF attempt_state IN ('submitting', 'submission_uncertain', 'submitted') THEN
    RAISE EXCEPTION 'Resolve the submission with evidence before releasing its reservation';
  END IF;
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER personal_reservation_preserve BEFORE DELETE OR UPDATE ON personal_reservations
FOR EACH ROW EXECUTE FUNCTION personal_reservation_preserve();
