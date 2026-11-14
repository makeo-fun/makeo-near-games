// The real room transport: an AI seat joins a live Makeo free match on app-dev the way the Games SDK
// does in a browser, with local keys instead of Privy (app src/worker/free-matches.ts, rooms-sdk.ts,
// games-api.ts issueRoomTicket; platform games-sdk contest-play.ts; keeper hidden.ts).
//
//   open:  POST /api/games/<p>/free-matches {seats}                    -> {room}; instance "<p>:live:<room>:free" (paid.instance)
//   seat:  POST /api/games/<p>/rooms/<room>/free-entry {wallet, grant, public_key, signature}
//          signature = session key over freeEntryDigest(room, wallet); grant.app = "create-<p>"
//   join:  POST /api/games/<p>/rooms/<room>/ticket?scope=live {name}   -> {ticket, playerId} (+ guest cookie)
//          WS   /api/games/<p>/rooms/<room>/connect?ticket=…&scope=live
//          messages: ready / match / paid (the room's paid snapshot) / command:ack
//   move:  {type:"paid:action", commandId, id, actor, action, session, signature}, action sealed
//          to paid.hidden.seal_key as {sealed, commit} (same as SDK sealMove)
//   view:  POST /api/games/<p>/rooms/<room>/view {wallet, grant, signature, at_ms, reply_key}
//          signature over makeo:keeper:view:v2 {instance, wallet, at_ms, reply_key}; the keeper seals the
//          view to reply_key (a P-256 key made for this one request) -> {sealed_view}
import { actionDigest, runtimeHash, seal, sealedCommitment, sha256Hex, type SessionGrant } from "./crypto";
import type { Signature } from "./seat";
import type { Ack, Envelope, RoomInfo, RoomStatus, RoomTransport, ViewRequest } from "./transport";

export const FINISHED_PHASES = new Set(["Settled", "Voided", "Closed", "Finished", "Expired", "Paid", "Refunded", "Over"]);
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (b: Uint8Array) => `0x${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;

/** What a player's move signer signs to take a free match's seat (app free-matches.ts freeEntryDigest). */
export const freeEntryDigest = (room: string, wallet: string) => `0x${sha256Hex(utf8(`makeo:free-entry:v1:${room}:${wallet.toLowerCase()}`))}`;
/** v2 view request: names the reply key the view is sealed back to (keeper hidden.ts viewRequestDigest). */
export const viewRequestDigestV2 = (instance: string, wallet: string, atMs: number, replyKey: string) =>
  runtimeHash("makeo:keeper:view:v2", { instance, wallet: wallet.toLowerCase(), at_ms: atMs, reply_key: replyKey.toLowerCase() });

// ---- Sealed views (games-sdk sealing.ts openView: same ECDH/HKDF/AES-GCM, info "makeo:sealed-view:v1") ----
const VIEW_INFO = utf8("makeo:sealed-view:v1") as Uint8Array<ArrayBuffer>;
export async function openView(privateKey: CryptoKey, instance: string, wallet: string, atMs: number, sealed: string): Promise<unknown> {
  const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
  const ephemeral = await crypto.subtle.importKey("raw", bytes.slice(0, 65), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8(`${instance}\n${wallet.toLowerCase()}\n${atMs}`) as Uint8Array<ArrayBuffer>, info: VIEW_INFO }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(65, 77) }, key, bytes.slice(77));
  return JSON.parse(new TextDecoder().decode(plain));
}

export type Paid = { instance: string; manifestHash: string; chainId: number; head: string; count: number; view: { phase?: string; entrants?: string[]; log?: unknown[] } & Record<string, unknown> | null; hidden?: { seal_key?: string }; lobby?: { host: string | null }; free?: boolean; vault?: string; terms?: { max_players?: number; entry_deadline_ms?: number | null } | null };

export type MakeoTransportOptions = {
  /** e.g. https://app-dev.makeo.fun (MAKEO_PLATFORM_URL). */
  base: string;
  projectId: string;
  roomId: string;
  name?: string;
  /** Host only: start the match once this many players have entered. */
  startAt?: number;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

/** Opens a free match of a published game; returns its room id. */
export async function openFreeMatch(base: string, projectId: string, seats: number, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(`${base}/api/games/${projectId}/free-matches`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seats }) });
  const body = (await response.json().catch(() => ({}))) as { ok?: boolean; room?: string; error?: string };
  if (!response.ok || !body.room) throw new Error(`free match: ${body.error ?? `HTTP ${response.status}`}`);
  return body.room;
}

/** One seat's connection to a live room (each seat is its own guest: own cookie, own socket). */
export class MakeoTransport implements RoomTransport {
  private cookie = "";
  private socket: WebSocket | null = null;
  private paid: Paid | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private pending = new Map<string, (ack: Ack) => void>();
  private me: { wallet: string; grant: SessionGrant; sign: (d: string) => Promise<Signature> } | null = null;
  private starting = false;
  private closed = false;

  constructor(readonly options: MakeoTransportOptions) {}

  get instance() { return this.paid?.instance ?? `${this.options.projectId}:live:${this.options.roomId}:free`; }
  private url(path: string) { return `${this.options.base}/api/games/${encodeURIComponent(this.options.projectId)}/rooms/${encodeURIComponent(this.options.roomId)}${path}`; }
  private log(line: string) { this.options.log?.(`[makeo ${this.options.name ?? ""}] ${line}`); }

  private async post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const response = await (this.options.fetch ?? fetch)(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.options.base, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: JSON.stringify(body),
    });
    const set = response.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0]!;
    return { status: response.status, body: (await response.json().catch(() => ({}))) as T };
  }

  /** Connects the guest socket (once) and waits for the room's paid snapshot. */
  private connect() {
    this.ready ??= (async () => {
      const ticket = await this.post<{ ticket?: string; playerId?: string; error?: string }>("/ticket?scope=live", { name: this.options.name ?? "AI" });
      if (!ticket.body.ticket) throw new Error(`ticket: ${ticket.body.error ?? ticket.status}`);
      const ws = new URL(this.url("/connect"));
      ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
      ws.searchParams.set("ticket", ticket.body.ticket);
      ws.searchParams.set("scope", "live");
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(ws.toString(), { headers: { origin: this.options.base, ...(this.cookie ? { cookie: this.cookie } : {}) } } as never);
        this.socket = socket;
        const timer = setTimeout(() => reject(new Error("the room sent no snapshot")), 20_000);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as Record<string, any>;
          const paid = message.type === "paid" ? message.paid : message.type === "ready" || message.type === "match" ? message.match?.paid : message.type === "command:ack" ? message.snapshot?.paid : undefined;
          if (paid) { this.paid = paid; clearTimeout(timer); resolve(); this.changed(); }
          if (message.type === "command:ack" && this.pending.has(message.commandId)) {
            this.pending.get(message.commandId)!({ accepted: !!message.accepted, message: message.message, code: message.code });
            this.pending.delete(message.commandId);
          }
          if (message.type === "error") this.log(`room error: ${message.message ?? JSON.stringify(message)}`);
        });
        socket.addEventListener("close", (e) => {
          this.log(`socket closed ${e.code} ${e.reason}`);
          if (!this.closed) { this.ready = null; setTimeout(() => void this.connect().catch((err) => this.log(String(err))), 1000); }
        });
        socket.addEventListener("error", () => reject(new Error("websocket error")));
      });
    })();
    return this.ready;
  }

  private changed() {
    for (const l of [...this.listeners]) queueMicrotask(l);
    void this.maybeStart();
  }

  /** The room's public paid snapshot (connects first). Read-only: used to check a room before seating. */
  async snapshot(): Promise<Paid | null> {
    await this.connect();
    return this.paid;
  }

  async info(): Promise<RoomInfo> {
    await this.connect();
    const p = this.paid!;
    return { instance: p.instance || this.instance, manifestHash: p.manifestHash, chainId: p.chainId, sealKey: p.hidden?.seal_key ?? null, app: `create-${this.options.projectId}` };
  }

  /** Takes a free seat: the grant, plus the session key's signature over the free-entry digest. */
  async join(wallet: string, grant: SessionGrant, _name?: string, sign?: (digest: string) => Promise<Signature>): Promise<Ack> {
    if (!sign) return { accepted: false, message: "a live seat needs its session key to sign the free entry" };
    await this.connect();
    wallet = wallet.toLowerCase();
    this.me = { wallet, grant, sign };
    if (!(this.paid?.view?.entrants ?? []).map((w) => w.toLowerCase()).includes(wallet)) {
      const { signature, public_key } = await sign(freeEntryDigest(this.options.roomId, wallet));
      const entry = await this.post<{ ok?: boolean; error?: string }>("/free-entry", { wallet, grant, public_key, signature });
      if (!entry.body.ok) return { accepted: false, message: entry.body.error ?? `free-entry HTTP ${entry.status}` };
    }
    this.socket?.send(JSON.stringify({ type: "paid:wallet", wallet }));
    this.log(`seated ${wallet}`);
    return { accepted: true };
  }

  /** The seat's own view, sealed by the keeper to a reply key made for this request. */
  async view(request: ViewRequest): Promise<unknown | null> {
    if (!this.me) throw new Error("join first");
    const info = await this.info();
    const reply = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
    const reply_key = hex(new Uint8Array(await crypto.subtle.exportKey("raw", reply.publicKey)));
    const at_ms = Date.now();
    const { signature } = await this.me.sign(viewRequestDigestV2(info.instance, request.wallet, at_ms, reply_key));
    const answer = await this.post<{ sealed_view?: string; view?: unknown; error?: string }>("/view", { wallet: request.wallet.toLowerCase(), grant: request.grant, signature, at_ms, reply_key });
    if (answer.status === 409) return null;
    if (answer.status >= 400) throw new Error(`view: ${answer.body.error ?? answer.status}`);
    if (typeof answer.body.sealed_view === "string") return openView(reply.privateKey, info.instance, request.wallet, at_ms, answer.body.sealed_view);
    return answer.body.view ?? null;
  }

  async publicLog() {
    const view = this.paid?.view;
    // A game's public log: view.log, or the game's own (NEARWOLF: view.game.log); else the whole view.
    const game = (view as { game?: { log?: unknown } } | null)?.game;
    return view ? (Array.isArray(view.log) ? view.log : Array.isArray(game?.log) ? (game!.log as unknown[]) : [view]) : [];
  }

  async status(): Promise<RoomStatus> {
    await this.connect();
    const view = this.paid?.view;
    // Over when the contest's phase says so, or the game itself does (Hold'em's view.game.finished).
    const game = (view as { game?: { finished?: unknown } } | null)?.game;
    const finished = FINISHED_PHASES.has(String(view?.phase ?? "")) || view?.finished === true || game?.finished === true;
    return { finished, head: this.paid?.head ?? "", seats: view?.entrants ?? [] };
  }

  async submit(envelope: Envelope): Promise<Ack> {
    await this.connect();
    const commandId = crypto.randomUUID();
    const { id, event, signatures } = envelope;
    return new Promise<Ack>((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(commandId); resolve({ accepted: false, message: "no ack in 60 s" }); }, 60_000);
      this.pending.set(commandId, (ack) => { clearTimeout(timer); resolve(ack); });
      this.socket!.send(JSON.stringify({ type: "paid:action", commandId, id, actor: event.actor.toLowerCase(), action: event.action, session: event.session, signature: signatures[0] }));
    });
  }

  subscribe(onChange: () => void) {
    this.listeners.add(onChange);
    return () => void this.listeners.delete(onChange);
  }

  close() { this.closed = true; this.socket?.close(); }

  /** The host starts the match ({series:"start"}, sealed like any move) once `startAt` players are in. */
  private async maybeStart() {
    const view = this.paid?.view;
    if (!this.options.startAt || !this.me || this.starting || view?.phase !== "Open") return;
    if ((this.paid?.lobby?.host ?? view.entrants?.[0])?.toLowerCase() !== this.me.wallet) return;
    if ((view.entrants?.length ?? 0) < this.options.startAt) return;
    this.starting = true;
    try {
      const info = await this.info();
      const action = { series: "start" };
      let payload: unknown = action;
      if (info.sealKey) {
        const nonce = hex(crypto.getRandomValues(new Uint8Array(16))).slice(2);
        payload = { sealed: await seal(info.sealKey, info.instance, { action, nonce }), commit: sealedCommitment(action, nonce) };
      }
      const id = `move-${crypto.randomUUID()}`;
      const signature = await this.me.sign(actionDigest(info.manifestHash, id, this.me.wallet, payload));
      const ack = await this.submit({ id, event: { kind: "Action", actor: this.me.wallet, action: payload, session: this.me.grant }, signatures: [signature] });
      this.log(`start: ${ack.accepted ? "accepted" : ack.message}`);
      if (!ack.accepted) this.starting = false;
    } catch (e) {
      this.starting = false;
      this.log(`start failed: ${(e as Error).message}`);
    }
  }
}
