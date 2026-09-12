-- Every config write now leaves a snapshot behind: the state before the change
-- and the state after it. `reason` says which change. `checkpoint` marks the
-- snapshots the watchdog may restore unasked — a write onto a config a reload
-- had emptied is history, not a baseline. Rows from before are checkpoints.
ALTER TABLE "caddy_snapshots" ADD COLUMN "reason" TEXT;
ALTER TABLE "caddy_snapshots" ADD COLUMN "checkpoint" BOOLEAN NOT NULL DEFAULT true;
