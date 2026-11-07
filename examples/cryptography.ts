// cryptography — pyca/cryptography from Node.js
//
// Uses the Python cryptography package through node-python: hashes and HMAC,
// RSA, EC and DSA key pairs, signatures, an X.509 certificate signing
// request and a self-signed certificate. Every result is checked with
// node:crypto: keys, signatures and certificates cross the two languages as
// PEM / DER bytes (Buffers), so this is also an interoperability test.
//
// Usage:
//   python -m pip install cryptography
//   PYTHON="$(python -c 'import sys; print(sys.executable)')" node examples/cryptography.ts
//   PYTHON=/path/to/venv/bin/python node examples/cryptography.ts

import crypto from "node:crypto";
import { Python, PythonError, kwargs, type PythonObject } from "@node-ctypes/python";

const python = await Python.initialize();

console.log("═══════════════════════════════════════════════════════════");
console.log(` pyca/cryptography from Node.js (Python ${python.version})`);
console.log("═══════════════════════════════════════════════════════════\n");

let cryptography: PythonObject;
try {
  cryptography = await python.import("cryptography");
} catch (error) {
  if (!(error instanceof PythonError) || error.type !== "ModuleNotFoundError" || error.exception.name !== "cryptography") throw error;
  console.log(`    cryptography is not installed for Python ${python.version} (${python.executable}): skipped`);
  console.log("    Install it with this interpreter using -m pip install cryptography, or set PYTHON to the interpreter where it is installed.");
  error.exception[Symbol.dispose]();
  console.log("\n    Done!");
  await python.finalize();
  process.exit(0);
}
console.log(`    cryptography ${cryptography.__version__}\n`);

const hashes = await python.import("cryptography.hazmat.primitives.hashes");
const hmac = await python.import("cryptography.hazmat.primitives.hmac");
const serialization = await python.import("cryptography.hazmat.primitives.serialization");
const rsa = await python.import("cryptography.hazmat.primitives.asymmetric.rsa");
const ec = await python.import("cryptography.hazmat.primitives.asymmetric.ec");
const dsa = await python.import("cryptography.hazmat.primitives.asymmetric.dsa");
const padding = await python.import("cryptography.hazmat.primitives.asymmetric.padding");
const x509 = await python.import("cryptography.x509");
const { NameOID } = await python.import("cryptography.x509.oid");
const { InvalidSignature } = await python.import("cryptography.exceptions");
const { Encoding, PrivateFormat, PublicFormat, NoEncryption, BestAvailableEncryption } = serialization;

const message = Buffer.from("node-ctypes ♥ pyca/cryptography");
const sha256 = await hashes.SHA256(); // algorithm objects are stateless: one is enough

const pem = (bytes: Buffer): string => bytes.toString("utf8");
const check = (ok: unknown): string => {
  if (!ok) throw new Error("Cryptography interoperability verification failed");
  return "✓";
};

/** The public key of a Python private key, as PEM text for node:crypto. */
async function publicPem(privateKey: PythonObject): Promise<string> {
  const publicKey = await privateKey.public_key();
  return pem(await publicKey.public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo));
}

/** verify() of cryptography: true, or false on InvalidSignature. */
async function pyVerify(publicKey: PythonObject, ...args: unknown[]): Promise<boolean> {
  try {
    await publicKey.verify(...args);
    return true;
  } catch (error) {
    if (error instanceof PythonError && (await python.builtins.isinstance(error.exception, InvalidSignature))) return false;
    throw error;
  }
}

/** Locate a complete DER element without depending on an ASN.1 package. */
function derElement(bytes: Buffer, offset: number): { start: number; content: number; end: number } {
  const start = offset;
  if (offset + 2 > bytes.length) throw new Error("Truncated CSR DER element");
  offset++;
  let length = bytes[offset++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + count > bytes.length) throw new Error("Invalid CSR DER length");
    length = bytes.readUIntBE(offset, count);
    offset += count;
  }
  const end = offset + length;
  if (end > bytes.length) throw new Error("Truncated CSR DER content");
  return { start, content: offset, end };
}

// [1] hashes and HMAC, compared with node:crypto
console.log("[1] hashes and HMAC");
const algorithms: [label: string, python: PythonObject, node: string][] = [
  ["SHA-256", sha256, "sha256"],
  ["SHA-512", await hashes.SHA512(), "sha512"],
  ["SHA3-256", await hashes.SHA3_256(), "sha3-256"],
  ["BLAKE2b-512", await hashes.BLAKE2b(64), "blake2b512"],
];
for (const [label, algorithm, nodeName] of algorithms) {
  const hash = await hashes.Hash(algorithm);
  await hash.update(message);
  const pythonDigest: Buffer = await hash.finalize(); // bytes → Buffer
  const nodeDigest = crypto.createHash(nodeName).update(message).digest();
  console.log(`    ${label.padEnd(11)} ${pythonDigest.toString("hex").slice(0, 32)}… ${check(pythonDigest.equals(nodeDigest))} node:crypto`);
}

const secret = crypto.randomBytes(32);
const mac = await hmac.HMAC(secret, sha256);
await mac.update(message);
const tag: Buffer = await mac.finalize();
const nodeTag = crypto.createHmac("sha256", secret).update(message).digest();
console.log(`    HMAC-SHA256 ${tag.toString("hex").slice(0, 32)}… ${check(tag.equals(nodeTag))} node:crypto\n`);

// [2] RSA: key pair, encrypted PKCS#8, RSA-PSS signatures both ways
console.log("[2] RSA 2048");
const rsaKey = await rsa.generate_private_key(kwargs({ public_exponent: 65537, key_size: 2048 }));
const rsaPublic = await rsaKey.public_key();
const encryption = await BestAvailableEncryption(Buffer.from("s3cret"));
const rsaPrivatePem = pem(await rsaKey.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, encryption));
const rsaPublicPem = await publicPem(rsaKey);
console.log(`    private key: ${rsaPrivatePem.split("\n")[0]} (${rsaPrivatePem.length} chars)`);
console.log(`    public key:  ${rsaPublicPem.split("\n")[0]}`);

const mgf = await padding.MGF1(sha256);
const pss = await padding.PSS(kwargs({ mgf, salt_length: padding.PSS.MAX_LENGTH }));
const nodePss = { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_AUTO };

const rsaSignature: Buffer = await rsaKey.sign(message, pss, sha256);
const pythonVerifiesRsa = await pyVerify(rsaPublic, rsaSignature, message, pss, sha256);
const nodeVerifiesRsa = crypto.verify("sha256", message, { key: rsaPublicPem, ...nodePss }, rsaSignature);
console.log(`    Python signs (RSA-PSS, ${rsaSignature.length} bytes): Python verifies ${check(pythonVerifiesRsa)}, node:crypto verifies ${check(nodeVerifiesRsa)}`);

// The encrypted private key, opened by Node.js: Node.js signs, Python verifies.
const nodeRsaKey = crypto.createPrivateKey({ key: rsaPrivatePem, passphrase: "s3cret" });
const nodeRsaSignature = crypto.sign("sha256", message, { key: nodeRsaKey, ...nodePss });
const pythonVerifiesNodeRsa = await pyVerify(rsaPublic, nodeRsaSignature, message, pss, sha256);
console.log(`    node:crypto signs with the encrypted PKCS#8 key: Python verifies ${check(pythonVerifiesNodeRsa)}`);

const tampered = await pyVerify(rsaPublic, rsaSignature, Buffer.from("tampered"), pss, sha256);
console.log(`    tampered message: rejected by Python ${check(!tampered)} (InvalidSignature)\n`);

// [3] EC P-256 and ECDSA
console.log("[3] EC P-256 and ECDSA");
const ecKey = await ec.generate_private_key(await ec.SECP256R1());
const ecPublic = await ecKey.public_key();
const ecPublicPem = await publicPem(ecKey);
const ecdsa = await ec.ECDSA(sha256);
console.log(`    curve ${ecKey.curve.name}, ${ecKey.key_size}-bit key`);

const ecSignature: Buffer = await ecKey.sign(message, ecdsa); // DER, as node:crypto expects
const pythonVerifiesEc = await pyVerify(ecPublic, ecSignature, message, ecdsa);
const nodeVerifiesEc = crypto.verify("sha256", message, ecPublicPem, ecSignature);
console.log(`    Python signs (ECDSA, DER, ${ecSignature.length} bytes): Python verifies ${check(pythonVerifiesEc)}, node:crypto verifies ${check(nodeVerifiesEc)}`);

const ecPrivatePem = pem(await ecKey.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, await NoEncryption()));
const nodeEcSignature = crypto.sign("sha256", message, crypto.createPrivateKey(ecPrivatePem));
console.log(`    node:crypto signs: Python verifies ${check(await pyVerify(ecPublic, nodeEcSignature, message, ecdsa))}\n`);

// [4] DSA
console.log("[4] DSA 2048");
const dsaKey = await dsa.generate_private_key(kwargs({ key_size: 2048 }));
const dsaParameters = await dsaKey.parameters();
const { p, q } = await dsaParameters.parameter_numbers(); // Python ints: BigInt in JavaScript
console.log(`    p is ${p.toString(2).length} bits, q is ${q.toString(2).length} bits`);

const dsaSignature: Buffer = await dsaKey.sign(message, sha256);
const pythonVerifiesDsa = await pyVerify(await dsaKey.public_key(), dsaSignature, message, sha256);
const nodeVerifiesDsa = crypto.verify("sha256", message, await publicPem(dsaKey), dsaSignature);
console.log(`    Python signs (${dsaSignature.length} bytes): Python verifies ${check(pythonVerifiesDsa)}, node:crypto verifies ${check(nodeVerifiesDsa)}\n`);

// [5] X.509 certificate signing request, signed with the EC key
console.log("[5] X.509 CSR");
const subject = await x509.Name([await x509.NameAttribute(NameOID.COUNTRY_NAME, "IT"), await x509.NameAttribute(NameOID.ORGANIZATION_NAME, "node-ctypes"), await x509.NameAttribute(NameOID.COMMON_NAME, "example.com")]);
const altNames = await x509.SubjectAlternativeName([await x509.DNSName("example.com"), await x509.DNSName("www.example.com")]);

// Builders return a new builder at each step, as in Python's chained calls.
let csrBuilder = await x509.CertificateSigningRequestBuilder();
csrBuilder = await csrBuilder.subject_name(subject);
csrBuilder = await csrBuilder.add_extension(altNames, kwargs({ critical: false }));
const csr = await csrBuilder.sign(ecKey, sha256);

const csrPem = pem(await csr.public_bytes(Encoding.PEM));
const sanExtension = await csr.extensions.get_extension_for_class(x509.SubjectAlternativeName);
const csrNames: PythonObject = await sanExtension.value.get_values_for_type(x509.DNSName);
console.log(`    ${csrPem.split("\n")[0]} (${csrPem.length} chars), signature valid ${check(csr.is_signature_valid)}`);
console.log(`    subject ${await csr.subject.rfc4514_string()}, SAN ${csrNames.toJS<string[]>().join(", ")}`);

// CertificationRequest ::= SEQUENCE { certificationRequestInfo, signatureAlgorithm, signature BIT STRING }
const csrDer: Buffer = await csr.public_bytes(Encoding.DER);
const csrSequence = derElement(csrDer, 0);
const requestInfo = derElement(csrDer, csrSequence.content);
const signatureAlgorithm = derElement(csrDer, requestInfo.end);
const signatureBits = derElement(csrDer, signatureAlgorithm.end);
if (csrDer[signatureBits.start] !== 0x03 || csrDer[signatureBits.content] !== 0) throw new Error("Invalid CSR signature bit string");
const signedData = csrDer.subarray(requestInfo.start, requestInfo.end);
const csrSignature = csrDer.subarray(signatureBits.content + 1, signatureBits.end);
console.log(`    node:crypto verifies CSR signature ${check(crypto.verify("sha256", signedData, ecPublicPem, csrSignature))}\n`);

// [6] self-signed certificate (RSA key), read by node:crypto
console.log("[6] self-signed certificate");
const now = new Date(); // a Date is an aware datetime in Python
const nextYear = new Date(now.getTime() + 365 * 24 * 3600 * 1000);
const basicConstraints = await x509.BasicConstraints(kwargs({ ca: true, path_length: null }));

let builder = await x509.CertificateBuilder();
builder = await builder.subject_name(subject);
builder = await builder.issuer_name(subject);
builder = await builder.public_key(rsaPublic);
builder = await builder.serial_number(await x509.random_serial_number());
builder = await builder.not_valid_before(now);
builder = await builder.not_valid_after(nextYear);
builder = await builder.add_extension(basicConstraints, kwargs({ critical: true }));
builder = await builder.add_extension(altNames, kwargs({ critical: false }));
const certificate = await builder.sign(rsaKey, sha256);

const certificatePem = pem(await certificate.public_bytes(Encoding.PEM));
const fingerprint: Buffer = await certificate.fingerprint(sha256);
const pythonFingerprint = (fingerprint.toString("hex").toUpperCase().match(/../g) ?? []).join(":");
const validUntil = new Date(certificate.not_valid_after_utc).toISOString();
console.log(`    Python: serial ${certificate.serial_number.toString(16).slice(0, 16)}…, valid until ${validUntil}`);

const nodeCertificate = new crypto.X509Certificate(certificatePem);
console.log(`    node:crypto: subject ${nodeCertificate.subject.replaceAll("\n", ", ")}, CA ${nodeCertificate.ca}`);
console.log(`    node:crypto: self-signature ${check(nodeCertificate.verify(nodeCertificate.publicKey))}`);
console.log(`    node:crypto: checkHost("www.example.com") ${check(nodeCertificate.checkHost("www.example.com"))}`);
console.log(`    node:crypto: same SHA-256 fingerprint ${check(nodeCertificate.fingerprint256 === pythonFingerprint)}`);

console.log("\n    Done!");
