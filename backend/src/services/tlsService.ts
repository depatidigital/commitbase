import tls from 'node:tls';

/**
 * HTTPS detection by talking to the domain itself.
 *
 * Cloudflare only knows about zones it hosts, so a domain served from anywhere
 * else looks like it has no certificate. A TLS handshake against port 443 is
 * the ground truth: it answers for every domain, whoever terminates the TLS.
 *
 * null means "could not tell" (no answer on 443, DNS failure, timeout) — never
 * overwrite a known status with it.
 */

export type TlsState = {
  status: 'ACTIVE' | 'EXPIRED' | 'ERROR';
  expiry: Date | null;
  issuer: string | null;
};

const TIMEOUT_MS = 6000;

export function getTlsCertificate(name: string): Promise<TlsState | null> {
  const host = String(name || '').trim().toLowerCase();
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: TlsState | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };

    const socket = tls.connect({
      host,
      port: 443,
      servername: host,
      // read the certificate even when it fails validation — an expired or
      // mismatched cert is a real answer, not a connection error
      rejectUnauthorized: false,
      timeout: TIMEOUT_MS,
    });

    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();

      if (!cert || Object.keys(cert).length === 0) {
        return done({ status: 'ERROR', expiry: null, issuer: null });
      }

      const validTo = Date.parse(cert.valid_to);
      const expiry = Number.isFinite(validTo) ? new Date(validTo) : null;
      const issuer = cert.issuer?.O || cert.issuer?.CN || null;

      if (expiry && expiry.getTime() < Date.now()) {
        return done({ status: 'EXPIRED', expiry, issuer });
      }

      // authorized is false for a self-signed cert or a hostname mismatch —
      // a certificate is being served, but browsers will still warn
      done({ status: socket.authorized ? 'ACTIVE' : 'ERROR', expiry, issuer });
    });

    socket.once('timeout', () => done(null));
    socket.once('error', () => done(null));
  });
}
