// The AI actor runner. An AI seat is a normal Makeo player:
//   session key → fetch own sealed view → actor.prompt → NEAR AI Cloud (JSON) → fetch the response
//   signature → verify (verify/nearai.ts) → actor.parseMove → seal and submit the move → receipt.
// Any failure on the AI path (no key, timeout, bad JSON, illegal move, refused move) falls back to a
// scripted legal move, and the receipt says why. The game never stalls on the model.
import { actionDigest, runtimeHash, seal, sealedCommitment, sha256Hex, viewRequestDigest } from "./crypto";
import type { Inference } from "./nearai";
import { lineFor } from "./personas";
import { ReceiptStore } from "./receipts";
import { createSeat, type SeatSigner } from "./seat";
import type { RoomInfo, RoomTransport } from "./transport";
import type { GameActor, Persona, Receipt } from "./types";

/** Checks a NEAR AI response; verify/nearai.ts provides the real one. */
export type ResponseVerifier = (input: { chat_id: string; model: string; request_body: string; response_body: string }) =>
  Promise<{ verified: boolean; signature: string | null; signing_address: string | null; signed_text: string | null; signer: "model" | "gateway" | null; reason?: string }>;

export type SeatOptions = {
  game: string;
  actor: GameActor;
  persona: Persona;
  transport: RoomTransport;
  inference: Inference | null;
  verify: ResponseVerifier | null;
  receipts: ReceiptStore;
  /** EVM key for the seat (0x…); fresh if absent. */
  evmKey?: string;
  /** Minimum ms between seeing a turn and moving, so humans can follow. */
  thinkMs?: number;
  /** Say a public line with moves when the model gives one. */
  talk?: boolean;
  log?: (line: string) => void;
  random?: () => number;
};

export class ActorSeat {
  signer!: SeatSigner;
  private info!: RoomInfo;
  private busy = false;
  private again = false;
  private moved = new Set<string>();
  private moves = 0;
  private stopFn: (() => void) | null = null;
  private done!: Promise<void>;
  private resolveDone!: () => void;

  constructor(readonly options: SeatOptions) {}

  get wallet() { return this.signer.wallet; }
  get persona() { return this.options.persona; }

  /** Takes the seat. Resolves once seated; `finished` resolves when the game ends. */
  async start() {
    const o = this.options;
    this.info = await o.transport.info();
    this.signer = createSeat({ chainId: this.info.chainId, app: this.info.app, evmKey: o.evmKey });
    const ack = await o.transport.join(this.signer.wallet, this.signer.grant, o.persona.name, (d) => this.signer.sign(d));
    if (!ack.accepted) throw new Error(`${o.persona.name} could not join: ${ack.message}`);
    this.done = new Promise((r) => (this.resolveDone = r));
    this.stopFn = o.transport.subscribe(() => void this.wake());
    void this.wake();
    return this;
  }
  get finished() { return this.done; }
  stop() { this.stopFn?.(); this.resolveDone?.(); }

  private async wake() {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do { this.again = false; await this.step(); } while (this.again);
    } catch (e) {
      this.log(`error: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  /** Signs a fresh view request and fetches this seat's own view. */
  async ownView() {
    const at_ms = Date.now();
    const { signature } = await this.signer.sign(viewRequestDigest(this.info.instance, this.signer.wallet, at_ms));
    return this.options.transport.view({ wallet: this.signer.wallet, grant: this.signer.grant, signature, at_ms });
  }

  private async step() {
    const o = this.options;
    const status = await o.transport.status();
    if (status.finished) { this.stop(); return; }
    const view = await this.ownView();
    if (view === null) return;
    const legal = o.actor.legalMoves(view);
    if (!legal.length) return;
    // One move per distinct view: the same view after an accepted move means the room is catching up.
    const fingerprint = runtimeHash("makeo:actor:view:v1", JSON.parse(JSON.stringify(view)));
    if (this.moved.has(fingerprint)) return;
    this.moved.add(fingerprint);
    const started = Date.now();
    const round = o.actor.round?.(view) ?? this.moves + 1;
    const publicLog = await o.transport.publicLog();
    const decision = await this.decide(view, legal, publicLog, round);
    const wait = (o.thinkMs ?? 0) - (Date.now() - started);
    if (wait > 0) await Bun.sleep(wait);
    let ack = await this.submit(decision.move);
    if (!ack.accepted && !decision.receipt.fallback) {
      // The rules refused the model's move: play a scripted legal one instead, and say so.
      this.log(`refused (${ack.message}); falling back`);
      decision.receipt.fallback = `room refused: ${ack.message}`;
      decision.receipt.move = this.scripted(view, legal);
      ack = await this.submit(decision.receipt.move);
    }
    if (!ack.accepted) { this.log(`move refused: ${ack.message}`); this.moved.delete(fingerprint); return; }
    this.moves += 1;
    o.receipts.add(decision.receipt, decision.evidence);
    this.log(`${decision.receipt.fallback ? "scripted" : decision.receipt.verified ? "verified" : "UNVERIFIED"} move ${JSON.stringify(decision.receipt.move)}${decision.receipt.fallback ? ` (${decision.receipt.fallback})` : ""}`);
    if (o.talk !== false && decision.receipt.say && o.transport.say) await o.transport.say(this.signer.wallet, decision.receipt.say);
  }

  private scripted(view: unknown, legal: unknown[]) {
    const o = this.options;
    if (o.actor.fallback) return o.actor.fallback(view, legal, o.persona);
    return legal[Math.floor((o.random ?? Math.random)() * legal.length)];
  }

  private async decide(view: unknown, legal: unknown[], publicLog: unknown[], round: number) {
    const o = this.options;
    const base: Receipt = {
      game: o.game, seat: this.signer.wallet, round, model: o.inference?.model ?? "scripted",
      chat_id: null, request_sha256: null, response_sha256: null, signature: null, signing_address: null,
      verified: false, move: null, reasoning: null, signer: null, fallback: null, say: null, signed_text: null, at_ms: Date.now(),
    };
    if (!o.inference) {
      return { move: (base.move = this.scripted(view, legal)), receipt: { ...base, fallback: "AI off", say: lineFor(o.persona, "thinking", o.random) }, evidence: undefined };
    }
    const prompt = o.actor.prompt(view, publicLog, o.persona);
    let result;
    const t0 = Date.now();
    try {
      result = await o.inference.complete(prompt);
      base.inference_ms = Date.now() - t0;
    } catch (e) {
      const move = this.scripted(view, legal);
      return { move, receipt: { ...base, move, fallback: `NEAR AI: ${(e as Error).message}` }, evidence: undefined };
    }
    const receipt: Receipt = {
      ...base,
      chat_id: result.chat_id,
      request_sha256: sha256Hex(result.request_body),
      response_sha256: sha256Hex(result.response_body),
    };
    const evidence = { chat_id: result.chat_id, request_body: result.request_body, response_body: result.response_body };
    if (o.verify) {
      const t1 = Date.now();
      try {
        const v = await o.verify({ chat_id: result.chat_id, model: o.inference.model, request_body: result.request_body, response_body: result.response_body });
        Object.assign(receipt, { verified: v.verified, signature: v.signature, signing_address: v.signing_address, signed_text: v.signed_text, signer: v.signer });
        receipt.verify_ms = Date.now() - t1;
        if (!v.verified) this.log(`signature check failed: ${v.reason}`);
      } catch (e) {
        this.log(`signature check error: ${(e as Error).message}`);
      }
    }
    const json = result.json as { reasoning?: unknown; say?: unknown } | null;
    receipt.reasoning = typeof json?.reasoning === "string" ? json.reasoning.slice(0, 1000) : null;
    receipt.say = typeof json?.say === "string" && json.say.trim() ? json.say.trim().slice(0, 160) : null;
    let move = json === null ? null : o.actor.parseMove(json, legal);
    if (move === null || move === undefined) {
      receipt.fallback = json === null ? "the model did not answer JSON" : "the model's move was not legal";
      move = this.scripted(view, legal);
    }
    receipt.move = move;
    return { move, receipt, evidence };
  }

  /** Seals (hidden games) and signs the move as the Games SDK does, then hands it to the room. */
  private async submit(action: unknown) {
    const o = this.options;
    let payload = action;
    if (this.info.sealKey) {
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      payload = { sealed: await seal(this.info.sealKey, this.info.instance, { action, nonce }), commit: sealedCommitment(action, nonce) };
    }
    const id = `move-${crypto.randomUUID()}`;
    const signature = await this.signer.sign(actionDigest(this.info.manifestHash, id, this.signer.wallet, payload));
    return o.transport.submit({ id, event: { kind: "Action", actor: this.signer.wallet, action: payload, session: this.signer.grant }, signatures: [signature] });
  }

  private log(line: string) { this.options.log?.(`[${this.options.persona.name}] ${line}`); }
}

/** Runs N AI seats in one room until the game ends; publishes receipts at the end. */
export async function runActors(options: Omit<SeatOptions, "persona" | "receipts"> & { personas: Persona[]; receipts?: ReceiptStore; timeoutMs?: number; /** One transport per seat (live rooms: each seat is its own guest). */ transportFor?: (persona: Persona, index: number) => RoomTransport }) {
  const receipts = options.receipts ?? new ReceiptStore();
  const seats: ActorSeat[] = [];
  for (const [i, persona] of options.personas.entries()) {
    const transport = options.transportFor ? options.transportFor(persona, i) : options.transport;
    seats.push(await new ActorSeat({ ...options, transport, persona, receipts }).start());
  }
  const info = await options.transport.info();
  const timeout = options.timeoutMs ? Bun.sleep(options.timeoutMs).then(() => "timeout" as const) : new Promise<never>(() => {});
  const outcome = await Promise.race([Promise.all(seats.map((s) => s.finished)).then(() => "finished" as const), timeout]);
  seats.forEach((s) => s.stop());
  const file = outcome === "finished" ? receipts.publish(info.instance) : null;
  return { outcome, seats, receipts, file };
}
