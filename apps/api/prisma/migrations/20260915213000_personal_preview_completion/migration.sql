-- Completed offline previews remain distinct from submissions and retain their quota debit.
ALTER TYPE "personal_attempt_state" ADD VALUE 'previewed';
