// A local stand-in for a hidden Makeo room + keeper, as strict as the real pair: it checks the
// EIP-712 session grant, the session key's signature on every view request and move, opens each
// sealed move with its own P-256 sealing key and checks the commitment. Game streams plug in a
// small TypeScript reducer (MockGame) so 1 human + N actors can play before devnet is wired.
import { actionDigest, openSealed, runtimeHash, sealedCommitment, sealingKeys, verifySessionGrant, verifySessionSignature, viewRequestDigest, type SessionGrant } from "./crypto";
import type { Ack, Envelope, RoomInfo, RoomStatus, RoomTransport, ViewRequest } from "./transport";

/** The game, as a pure reducer. Throw from `apply` to refuse a move (the room answers accepted:false). */
export interface MockGame<State = any, Move = any> {
  /** Seats needed before `setup` runs. */
  seats: number;
  setup(seats: Array<{ wallet: string; name: string }>, random: () => number): State;
  /** What `wallet` may see (their sealed view). */
  view(state: State, wallet: string): unknown;
  /** What everyone may see. */
  publicLog(state: State): unknown[];
  apply(state: State, wallet: string, move: Move, random: () => number): State;
  finished(state: State): boolean;
  /** Optional: advance timers (called every `tickMs`); return the same state for no change. */
  tick?(state: State, nowMs: number, random: () => number): State;
}

/** A seeded PRNG (mulberry32) so a mock game replays from its seed. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type MockRoomOptions = { game: string; chainId?: number; seed?: number; sealed?: boolean; tickMs?: number; log?: (line: string) => void };

export class MockRoom<State = any> implements RoomTransport {
  private state: State | null = null;
  private seats: Array<{ wallet: string; name: string }> = [];
  private grants = new Map<string, SessionGrant>();
  private listeners = new Set<() => void>();
  private seal!: { pair: CryptoKeyPair; publicHex: string };
  private head = "0x00";
  private count = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly random: () => number;
  readonly chat: Array<{ wallet: string; name: string; text: string; at_ms: number }> = [];
  readonly instance: string;
  readonly manifestHash: string;
  readonly chainId: number;

  private constructor(readonly game: MockGame<State>, readonly options: MockRoomOptions) {
    this.chainId = options.chainId ?? 398;
    this.random = seeded(options.seed ?? Date.now());
    this.instance = `${options.game}:mock:${(options.seed ?? Date.now()).toString(36)}`;
    this.manifestHash = runtimeHash("makeo:runtime:manifest:v1", { game: options.game, mock: true, instance: this.instance });
  }

  static async create<S>(game: MockGame<S>, options: MockRoomOptions) {
    const room = new MockRoom<S>(game, options);
    room.seal = await sealingKeys();
    if (game.tick) room.timer = setInterval(() => room.runTick(), options.tickMs ?? 1000);
    return room;
  }

  close() { if (this.timer) clearInterval(this.timer); this.listeners.clear(); }

  async info(): Promise<RoomInfo> {
    return { instance: this.instance, manifestHash: this.manifestHash, chainId: this.chainId, sealKey: this.options.sealed === false ? null : this.seal.publicHex, app: this.options.game };
  }

  async join(wallet: string, grant: SessionGrant, name?: string): Promise<Ack> {
    wallet = wallet.toLowerCase();
    try { verifySessionGrant(this.chainId, wallet, grant); } catch (e) { return { accepted: false, message: (e as Error).message }; }
    this.grants.set(wallet, grant);
    if (this.seats.some((s) => s.wallet === wallet)) return { accepted: true };
    if (this.state) return { accepted: false, message: "the game has started" };
    if (this.seats.length >= this.game.seats) return { accepted: false, message: "the table is full" };
    this.seats.push({ wallet, name: name ?? wallet.slice(0, 8) });
    this.log(`join ${name ?? wallet}`);
    if (this.seats.length === this.game.seats) {
      this.state = this.game.setup(this.seats, this.random);
      this.bump("setup");
    } else this.notify();
    return { accepted: true };
  }

  async view(request: ViewRequest) {
    if (!this.state) return null;
    const wallet = request.wallet.toLowerCase();
    if (Math.abs(Date.now() - request.at_ms) > 120_000) throw new Error("a view request is signed within two minutes");
    verifySessionGrant(this.chainId, wallet, request.grant);
    verifySessionSignature(request.grant.key, request.signature, viewRequestDigest(this.instance, wallet, request.at_ms));
    return structuredClone(this.game.view(this.state, wallet));
  }

  async publicLog() { return this.state ? structuredClone(this.game.publicLog(this.state)) : []; }

  async status(): Promise<RoomStatus> {
    return { finished: !!this.state && this.game.finished(this.state), head: this.head, seats: this.seats.map((s) => s.wallet) };
  }

  async submit(envelope: Envelope): Promise<Ack> {
    if (!this.state) return { accepted: false, message: "the game has not started" };
    const actor = envelope.event.actor.toLowerCase();
    const grant = envelope.event.session ?? this.grants.get(actor);
    try {
      if (!this.seats.some((s) => s.wallet === actor)) throw new Error("not seated");
      if (!grant) throw new Error("no session");
      verifySessionGrant(this.chainId, actor, grant);
      const sig = envelope.signatures[0];
      if (!sig || sig.public_key !== grant.key) throw new Error("not signed by the seat's session key");
      verifySessionSignature(grant.key, sig.signature, actionDigest(this.manifestHash, envelope.id, actor, envelope.event.action));
      let move = envelope.event.action;
      const sealed = (move as { sealed?: unknown; commit?: unknown } | null)?.sealed;
      if (this.options.sealed !== false) {
        if (typeof sealed !== "string") throw new Error("this game takes sealed moves");
        const opened = await openSealed(this.seal.pair.privateKey, this.instance, sealed);
        if (sealedCommitment(opened.action, opened.nonce) !== (move as { commit?: string }).commit) throw new Error("the opened move does not match what was sealed");
        move = opened.action;
      }
      if (this.game.finished(this.state)) throw new Error("the game is over");
      this.state = this.game.apply(this.state, actor, move, this.random);
      this.log(`move ${this.name(actor)} ${JSON.stringify(move)}`);
      this.bump(envelope.id);
      return { accepted: true };
    } catch (e) {
      this.log(`refused ${this.name(actor)}: ${(e as Error).message}`);
      return { accepted: false, message: (e as Error).message };
    }
  }

  async say(wallet: string, text: string) {
    wallet = wallet.toLowerCase();
    this.chat.push({ wallet, name: this.name(wallet), text, at_ms: Date.now() });
    this.log(`${this.name(wallet)}: “${text}”`);
    this.notify();
  }

  subscribe(onChange: () => void) {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  }

  /** For tests and the harness: the full state (the real keeper never shows this mid-game). */
  peek() { return this.state; }
  name(wallet: string) { return this.seats.find((s) => s.wallet === wallet.toLowerCase())?.name ?? wallet.slice(0, 8); }

  private runTick() {
    if (!this.state || !this.game.tick || this.game.finished(this.state)) return;
    const next = this.game.tick(this.state, Date.now(), this.random);
    if (next !== this.state) { this.state = next; this.bump("tick"); }
  }
  private bump(id: string) {
    this.count += 1;
    this.head = runtimeHash("makeo:mock:head:v1", { previous: this.head, id, count: this.count });
    this.notify();
  }
  private notify() { for (const l of [...this.listeners]) queueMicrotask(l); }
  private log(line: string) { this.options.log?.(`[room] ${line}`); }
}

/** Serves a MockRoom over HTTP (for a browser client or actors in another process). */
export function serveMockRoom(room: MockRoom, port = 8787) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } });
  return Bun.serve({
    port,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "OPTIONS") return new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" } });
      const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};
      try {
        if (path === "/info") return json(await room.info());
        if (path === "/status") return json(await room.status());
        if (path === "/log") return json({ log: await room.publicLog(), chat: room.chat });
        if (path === "/join") return json(await room.join(body.wallet, body.grant, body.name));
        if (path === "/view") { const view = await room.view(body as ViewRequest); return view === null ? json({ error: "not started" }, 409) : json({ view }); }
        if (path === "/move") return json(await room.submit(body as Envelope));
        if (path === "/say") { await room.say(body.wallet, String(body.text ?? "").slice(0, 280)); return json({ ok: true }); }
        return json({ error: "not found" }, 404);
      } catch (e) {
        return json({ error: (e as Error).message }, 401);
      }
    },
  });
}
