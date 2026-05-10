/**
 * RFC 3161 Time-Stamp Authority client.
 *
 * Sends a SHA-256 digest to a TSA over HTTP and stores the returned
 * TimeStampResp (DER bytes) verbatim in audit_meta_sth.tsa_token.
 *
 * The token is a SignedData containing the digest + a signed timestamp.
 * Verifiers re-validate it independently against the TSA's published
 * root certificate chain — we don't parse it server-side.
 *
 * TimeStampReq DER encoding (RFC 3161 §2.4.1):
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version              INTEGER  { v1(1) },
 *     messageImprint       MessageImprint,
 *     reqPolicy            OBJECT IDENTIFIER  OPTIONAL,
 *     nonce                INTEGER  OPTIONAL,
 *     certReq              BOOLEAN  DEFAULT FALSE,
 *     extensions           [0] IMPLICIT Extensions OPTIONAL
 *   }
 *   MessageImprint ::= SEQUENCE {
 *     hashAlgorithm        AlgorithmIdentifier,
 *     hashedMessage        OCTET STRING
 *   }
 *
 * AlgorithmIdentifier for SHA-256: OID 2.16.840.1.101.3.4.2.1
 *   DER: 30 0d 06 09 60 86 48 01 65 03 04 02 01 05 00
 */

const SHA256_ALG_ID = Buffer.from('300d060960864801650304020105000420', 'hex'); // includes OCTET STRING tag (04) + len 32 (20)
// We append the 32-byte digest to that prefix to form the messageImprint contents.

function derSequence(contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x30]), derLength(contents.length), contents]);
}
function derLength(n: number): Buffer {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
const VERSION_V1 = Buffer.from([0x02, 0x01, 0x01]); // INTEGER 1
const CERT_REQ_TRUE = Buffer.from([0x01, 0x01, 0xff]); // BOOLEAN TRUE

export interface RequestTimestampOptions {
  tsaUrl: string;
  sha256Digest: Buffer;     // 32 bytes
  certReq?: boolean;        // default true (request signing cert)
}

function buildTimestampReq(digest: Buffer, certReq: boolean): Buffer {
  if (digest.length !== 32) throw new Error('SHA-256 digest must be 32 bytes');
  const messageImprintContents = Buffer.concat([SHA256_ALG_ID, digest]);
  // SHA256_ALG_ID already begins with the AlgorithmIdentifier SEQUENCE
  // and the OCTET STRING tag+len for a 32-byte digest, so concatenating
  // the digest yields the inner content of the messageImprint SEQUENCE.
  const messageImprint = derSequence(messageImprintContents);
  const parts: Buffer[] = [VERSION_V1, messageImprint];
  if (certReq) parts.push(CERT_REQ_TRUE);
  return derSequence(Buffer.concat(parts));
}

export async function requestTimestampToken(opts: RequestTimestampOptions): Promise<Buffer> {
  const body = buildTimestampReq(opts.sha256Digest, opts.certReq ?? true);
  const res = await fetch(opts.tsaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/timestamp-query' },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TSA ${opts.tsaUrl} → ${res.status}: ${text.slice(0, 200)}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
