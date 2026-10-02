// AES-256-GCM encrypt/decrypt for Researcher.GoogleFormsRefreshTokenEnc — same generic logic as
// server/calendar/tokenCrypto.mjs (duplicated, not shared, per this project's established
// per-credential-type convention: a compromise of one key shouldn't expose the other's tokens),
// with its own env var so the two connections can be rotated independently.
//
// GOOGLE_FORMS_TOKEN_ENCRYPTION_KEY is a 32-byte key, hex-encoded, in .env (generate once with:
// node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"). Never hardcoded,
// never committed.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV size for GCM

function getKey() {
  const hex = process.env.GOOGLE_FORMS_TOKEN_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'GOOGLE_FORMS_TOKEN_ENCRYPTION_KEY is not set — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error('GOOGLE_FORMS_TOKEN_ENCRYPTION_KEY must be a 32-byte value, hex-encoded (64 hex characters).');
  }
  return key;
}

/** Returns a single string ("iv:authTag:ciphertext", each hex-encoded) safe to store in a TEXT column. */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('hex'), authTag.toString('hex'), ciphertext.toString('hex')].join(':');
}

export function decrypt(stored) {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = String(stored).split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted value — expected "iv:authTag:ciphertext".');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}
