import { createHash, randomUUID } from "node:crypto";
import { LIMITS } from "../core/limits.js";

/** Payload sealed into an MRTR requestState for one delegate_respond elicitation round. */
export interface SealedInputState {
  jobId: string;
  /** The clarification round this state was minted for; stale rounds are rejected. */
  round: number;
  /** Stable hash of the exact question text, so an edited question invalidates the state. */
  questionRevision: string;
  nonce: string;
}

/** Stable, non-reversible fingerprint of a clarification question for staleness checks. */
export function hashQuestion(question: string): string {
  return createHash("sha256").update(question).digest("hex").slice(0, 16);
}

/**
 * Bounded single-use nonce store: a sealed requestState is good for exactly one
 * reply, so consuming its nonce turns a replay into a rejection. Entries are pruned lazily and capped so a long-lived process can't grow unbounded.
 */
export class NonceLedger {
  private readonly expiryByNonce = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** Mint a fresh single-use nonce for one elicitation round. */
  issue(): string {
    this.prune();
    if (this.expiryByNonce.size >= LIMITS.maxPendingInputStates) {
      const oldest = this.expiryByNonce.keys().next().value;
      if (oldest !== undefined) this.expiryByNonce.delete(oldest);
    }
    const nonce = randomUUID();
    this.expiryByNonce.set(nonce, Date.now() + this.ttlMs);
    return nonce;
  }

  /** Consume a nonce exactly once; false for unknown, already-used, or expired — the replay rejection. */
  consume(nonce: string): boolean {
    const expiry = this.expiryByNonce.get(nonce);
    this.expiryByNonce.delete(nonce);
    return expiry !== undefined && expiry >= Date.now();
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, expiry] of this.expiryByNonce) if (expiry < now) this.expiryByNonce.delete(nonce);
  }
}
