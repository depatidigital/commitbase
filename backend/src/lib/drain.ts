import { existsSync } from 'fs';

/**
 * Upgrade drain. While larika-upgrade.sh holds this file, deploys queue as
 * PENDING instead of starting and running ones finish; once none runs the
 * panel writes DRAINED_FILE, and the script restarts it on the new release.
 * Queued rows survive the restart (resumeQueuedDeploys). A file, not an HTTP
 * call: behind Caddy every request comes from localhost, and a signal cannot
 * be taken back when the script gives up waiting.
 */
export const DRAIN_FILE = process.env.LARIKA_DRAIN_FILE || '/opt/larika/shared/drain';
export const DRAINED_FILE = `${DRAIN_FILE}.idle`;

export const draining = () => existsSync(DRAIN_FILE);
