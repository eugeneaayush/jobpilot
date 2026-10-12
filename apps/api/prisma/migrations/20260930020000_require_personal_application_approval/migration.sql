-- Existing attempt manifests and submission reservations remain immutable audit evidence.
UPDATE campaigns
SET config = jsonb_set(
  config::jsonb,
  '{personal}',
  (config::jsonb -> 'personal') || jsonb_build_object('approvalPolicy', 'per-application-v1') ||
    CASE WHEN config::jsonb #>> '{personal,mode}' IN ('submit', 'live_preview')
      THEN jsonb_build_object('enabled', false, 'authorization', NULL)
      ELSE '{}'::jsonb END
),
status = CASE WHEN config::jsonb #>> '{personal,mode}' IN ('submit', 'live_preview') THEN 'paused'::campaign_status ELSE status END,
updated_at = CURRENT_TIMESTAMP
WHERE jsonb_typeof(config::jsonb -> 'personal') = 'object';
