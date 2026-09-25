-- CreateTable
CREATE TABLE "personal_policies" (
    "user_id" TEXT NOT NULL,
    "daily_cap" INTEGER NOT NULL DEFAULT 50,
    "employer_active_cap" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "monthly_budget_cents" INTEGER NOT NULL DEFAULT 20000,
    "search_budget_cents" INTEGER NOT NULL DEFAULT 5000,
    "version" TEXT NOT NULL DEFAULT 'graduate-experienced-v1',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_policies_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "personal_sources" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "attempted_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "next_eligible_at" TIMESTAMP(3),
    "status" "personal_discovery_status",
    "coverage" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "personal_employer_aliases" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_employer" TEXT NOT NULL,
    "canonical_employer" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_employer_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_sources_user_id_identity_key" ON "personal_sources"("user_id", "identity");

-- CreateIndex
CREATE INDEX "personal_employer_aliases_user_id_canonical_employer_idx" ON "personal_employer_aliases"("user_id", "canonical_employer");

-- CreateIndex
CREATE UNIQUE INDEX "personal_employer_aliases_user_id_source_employer_key" ON "personal_employer_aliases"("user_id", "source_employer");

-- AddForeignKey
ALTER TABLE "personal_policies" ADD CONSTRAINT "personal_policies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_sources" ADD CONSTRAINT "personal_sources_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "personal_employer_aliases" ADD CONSTRAINT "personal_employer_aliases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "personal_policies" ADD CONSTRAINT "personal_policy_limits" CHECK (
    daily_cap BETWEEN 0 AND 50 AND employer_active_cap BETWEEN 0 AND 3
    AND monthly_budget_cents BETWEEN 0 AND 20000
    AND search_budget_cents BETWEEN 0 AND 5000
    AND search_budget_cents <= monthly_budget_cents
);
