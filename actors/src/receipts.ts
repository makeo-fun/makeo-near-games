// Receipts per SPEC.md: one per AI move. `reasoning` stays private until the game ends; then
// publish() writes the full set (with the exact request/response bytes, so anyone can recheck).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, Receipt } from "./types";

export class ReceiptStore {
  private receipts: Receipt[] = [];
  private evidence = new Map<string, Evidence>();
  private finished = false;
  private attestation: unknown = null;

  /** The NEAR AI attestation evidence (nonce + raw report + checks) the receipts' signers were matched to. */
  setAttestation(attestation: unknown) { this.attestation = attestation; }

  constructor(private readonly dir?: string) {}

  add(receipt: Receipt, evidence?: Evidence) {
    this.receipts.push(receipt);
    if (evidence) this.evidence.set(evidence.chat_id, evidence);
    this.save();
  }

  /** What may be shown now: before the end, without reasoning. */
  list(): Receipt[] {
    return this.receipts.map((r) => (this.finished ? r : { ...r, reasoning: null }));
  }
  all(): Receipt[] { return [...this.receipts]; }
  evidenceFor(chatId: string) { return this.evidence.get(chatId) ?? null; }

  /** The game is over: reasoning and evidence become public. */
  publish(instance: string) {
    this.finished = true;
    if (!this.dir) return null;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${safe(instance)}.receipts.json`);
    writeFileSync(file, JSON.stringify({ instance, published_at_ms: Date.now(), receipts: this.receipts, evidence: [...this.evidence.values()], ...(this.attestation ? { attestation: this.attestation } : {}) }, null, 2));
    return file;
  }

  /** Private working copy during the game (reasoning included; keep this directory private). */
  private save() {
    if (!this.dir) return;
    mkdirSync(join(this.dir, "private"), { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, "private", "latest.json"), JSON.stringify({ receipts: this.receipts }, null, 2), { mode: 0o600 });
  }
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]+/g, "_");
