// A human seat for mock rooms and tests: the same identity and signing as an AI seat, but the
// caller picks the moves. `bun actors/src/harness.ts` gives it a terminal prompt.
import { actionDigest, seal, sealedCommitment, viewRequestDigest } from "./crypto";
import { createSeat, type SeatSigner } from "./seat";
import type { RoomInfo, RoomTransport } from "./transport";

export class HumanSeat {
  signer!: SeatSigner;
  private info!: RoomInfo;
  constructor(private readonly transport: RoomTransport, readonly name = "You") {}

  async join() {
    this.info = await this.transport.info();
    this.signer = createSeat({ chainId: this.info.chainId, app: this.info.app });
    const ack = await this.transport.join(this.signer.wallet, this.signer.grant, this.name);
    if (!ack.accepted) throw new Error(ack.message);
    return this;
  }
  get wallet() { return this.signer.wallet; }

  async view() {
    const at_ms = Date.now();
    const { signature } = await this.signer.sign(viewRequestDigest(this.info.instance, this.signer.wallet, at_ms));
    return this.transport.view({ wallet: this.signer.wallet, grant: this.signer.grant, signature, at_ms });
  }

  async play(action: unknown) {
    let payload = action;
    if (this.info.sealKey) {
      const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
      payload = { sealed: await seal(this.info.sealKey, this.info.instance, { action, nonce }), commit: sealedCommitment(action, nonce) };
    }
    const id = `move-${crypto.randomUUID()}`;
    const signature = await this.signer.sign(actionDigest(this.info.manifestHash, id, this.signer.wallet, payload));
    return this.transport.submit({ id, event: { kind: "Action", actor: this.signer.wallet, action: payload, session: this.signer.grant }, signatures: [signature] });
  }

  say(text: string) { return this.transport.say?.(this.signer.wallet, text); }
}
