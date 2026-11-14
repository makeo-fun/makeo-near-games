// The one small interface between the runner and a Makeo room. Today: MockRoom (in-process) and
// HttpTransport (a mock room served over HTTP, or the Makeo platform once devnet is wired).
// Shapes follow the platform: a move is an Action event signed with the session key over
// actionDigest(manifestHash, id, actor, action); a hidden game's action is {sealed, commit}; a
// seat's own view is POSTed {wallet, grant, signature, at_ms} (keeper hidden.ts `view`).
import type { SessionGrant } from "./crypto";
import type { Signature } from "./seat";

export type RoomInfo = {
  /** "<projectId>:<scope>:<roomId>", the keeper's instance id. */
  instance: string;
  manifestHash: string;
  chainId: number;
  /** Executor's P-256 sealing key (0x04…) for hidden games; null if moves go in the clear. */
  sealKey: string | null;
  /** The app name session grants carry. */
  app?: string;
};

export type ViewRequest = { wallet: string; grant: SessionGrant; signature: string; at_ms: number };
export type ActionEvent = { kind: "Action"; actor: string; action: unknown; session?: SessionGrant };
export type Envelope = { id: string; event: ActionEvent; signatures: Signature[] };
export type Ack = { accepted: boolean; message?: string; code?: string };
export type RoomStatus = { finished: boolean; head: string; seats: string[] };

export interface RoomTransport {
  info(): Promise<RoomInfo>;
  /** Takes a seat (idempotent). */
  join(wallet: string, grant: SessionGrant, name?: string): Promise<Ack>;
  /** The seat's own (sealed) view; null before the game has started. */
  view(request: ViewRequest): Promise<unknown | null>;
  /** What everyone may see. */
  publicLog(): Promise<unknown[]>;
  status(): Promise<RoomStatus>;
  submit(envelope: Envelope): Promise<Ack>;
  /** Calls back when the room changes; returns unsubscribe. */
  subscribe(onChange: () => void): () => void;
  /** Public chat line (in-character talk); optional. */
  say?(wallet: string, text: string): Promise<void>;
}

/** Client side of serveMockRoom (mock-room.ts); also the shape to point at the platform's endpoints. */
export class HttpTransport implements RoomTransport {
  constructor(private readonly base: string, private readonly fetcher: typeof fetch = fetch) {}
  private async call<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.fetcher(`${this.base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const answer = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (response.status === 409) return null as T;
    if (!response.ok) throw new Error(answer.error ?? `room answered ${response.status}`);
    return answer;
  }
  info() { return this.call<RoomInfo>("/info"); }
  join(wallet: string, grant: SessionGrant, name?: string) { return this.call<Ack>("/join", { wallet, grant, name }); }
  async view(request: ViewRequest) { return (await this.call<{ view: unknown } | null>("/view", request))?.view ?? null; }
  async publicLog() { return (await this.call<{ log: unknown[] }>("/log")).log; }
  status() { return this.call<RoomStatus>("/status"); }
  submit(envelope: Envelope) { return this.call<Ack>("/move", envelope); }
  async say(wallet: string, text: string) { await this.call("/say", { wallet, text }); }
  subscribe(onChange: () => void) {
    let last = "";
    let alive = true;
    const tick = async () => {
      while (alive) {
        const s = await this.status().catch(() => null);
        if (s && s.head !== last) { last = s.head; onChange(); }
        await Bun.sleep(400);
      }
    };
    void tick();
    return () => { alive = false; };
  }
}
