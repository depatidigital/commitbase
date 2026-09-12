/**
 * Output of a long root job (server setup, org provisioning), kept as a tail
 * and written to its database row every few seconds so a page can follow it
 * by polling.
 *
 * ponytail: DB polling, not a socket — a 2s lag is fine for jobs that take
 * seconds to minutes.
 */
export function liveLog(write: (text: string) => Promise<unknown>, tail = 8_000, everyMs = 2_000) {
  let text = '';
  let dirty = false;
  let flushing: Promise<unknown> = Promise.resolve();

  const ticker = setInterval(() => {
    if (!dirty) return;
    dirty = false;
    flushing = write(text).catch(() => {});
  }, everyMs);

  return {
    /** Every chunk as it arrives. The scripts colour their headings for a terminal; the view is plain text. */
    push(chunk: string) {
      text = (text + chunk.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-tail);
      dirty = true;
    },
    get text() {
      return text;
    },
    /** Stop, and wait out a write in flight — one landing after the final write would overwrite it with an older tail. */
    async stop() {
      clearInterval(ticker);
      await flushing;
    },
  };
}
