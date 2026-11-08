/**
 * Seller API keys at rest: AES-256-GCM, stored as "iv.tag.ciphertext" (base64 parts), with the seller id as
 * additional authenticated data so a ciphertext can't be moved to another seller's row.
 * Key: MASTER_KEY (32 bytes, hex or base64), else `<dataDir>/master.key` generated once with 0600 perms.
 * An in-memory database (tests) gets a throwaway key, so tests never touch data/.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kvGet, kvSet } from "../db/db";
import type { AppContext } from "../context";

export interface KeyVault {
  encrypt(plaintext: string, aad: string): string;
  /** Throws when the ciphertext was tampered with or sealed under another master key. */
  decrypt(sealed: string, aad: string): string;
  /** First 16 hex chars of SHA-256(key): identifies the key without revealing it. */
  readonly fingerprint: string;
}

const FINGERPRINT_KEY = "seller_vault.key_fingerprint";

/** 64 hex chars, or base64/base64url that decodes to exactly 32 bytes. */
export function parseMasterKey(text: string): Buffer {
  const value = text.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/.test(value)) {
    const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length === 32) return buf;
  }
  throw new Error("MASTER_KEY must be 32 bytes, given as 64 hex characters or base64.");
}

export function loadMasterKey(opts: { masterKey: string | null; dataDir: string; ephemeral: boolean }): Buffer {
  if (opts.masterKey) return parseMasterKey(opts.masterKey);
  if (opts.ephemeral) return randomBytes(32);
  const file = join(opts.dataDir, "master.key");
  if (existsSync(file)) return parseMasterKey(readFileSync(file, "utf8"));
  mkdirSync(opts.dataDir, { recursive: true });
  const key = randomBytes(32);
  // "wx": never overwrite a key another process created in the meantime.
  writeFileSync(file, `${key.toString("hex")}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return key;
}

export function createKeyVault(key: Buffer): KeyVault {
  if (key.length !== 32) throw new Error("AES-256-GCM needs a 32-byte key");
  return {
    fingerprint: createHash("sha256").update(key).digest("hex").slice(0, 16),
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(".");
    },
    decrypt(sealed, aad) {
      const parts = sealed.split(".");
      if (parts.length !== 3) throw new Error("Malformed sealed value");
      const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64")) as [Buffer, Buffer, Buffer];
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

const vaults = new WeakMap<AppContext, KeyVault>();

/** The context's vault, created on first use. Warns once when the master key changed since keys were stored. */
export function keyVault(ctx: AppContext): KeyVault {
  let vault = vaults.get(ctx);
  if (vault) return vault;
  vault = createKeyVault(
    loadMasterKey({ masterKey: ctx.config.masterKey, dataDir: ctx.config.dataDir, ephemeral: ctx.config.dbPath === ":memory:" }),
  );
  const stored = kvGet(ctx.db, FINGERPRINT_KEY);
  if (stored === null) kvSet(ctx.db, FINGERPRINT_KEY, vault.fingerprint);
  else if (stored !== vault.fingerprint) {
    ctx.log.warn("The master key changed: seller API keys stored earlier can't be decrypted. Re-enter them or restore the old key.");
  }
  vaults.set(ctx, vault);
  return vault;
}
