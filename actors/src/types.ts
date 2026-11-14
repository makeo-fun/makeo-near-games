// The actor protocol (SPEC.md "AI actor protocol") and the receipt format. Games implement
// GameActor in games/<game>/actor.ts; the runner (runner.ts) does everything else.

export type Persona = {
  /** Stable id, e.g. "mira". */
  id: string;
  /** Display name at the table. */
  name: string;
  /** How they talk: one line the prompt can quote ("dry, clipped, suspicious of everyone"). */
  voice: string;
  /** How they play: one line ("bluffs early, folds to big raises"). */
  style: string;
  /** Optional emoji or avatar key for the client. */
  avatar?: string;
  /** Optional short in-character lines by situation, for the scripted fallback and flavour. */
  lines?: Partial<Record<string, string[]>>;
};

export type Prompt = { system: string; user: string };

/** What games/<game>/actor.ts exports. View, Move and Event are the game's own types. */
export interface GameActor<View = any, Move = any, Event = any> {
  persona: Persona[];
  legalMoves(view: View): Move[];
  prompt(view: View, publicLog: Event[], persona: Persona): Prompt;
  /** `json` is the model's parsed JSON object; null → the runner plays a scripted legal move. */
  parseMove(json: unknown, legal: Move[]): Move | null;
  /** Optional: the round/turn number shown on receipts. The runner counts moves if absent. */
  round?(view: View): number;
  /** Optional: a scripted move when the model is off or wrong. Default: a random legal move. */
  fallback?(view: View, legal: Move[], persona: Persona): Move;
}

/** One AI move's proof, as SPEC.md fixes it (plus optional extras the Receipt screen may show). */
export type Receipt = {
  game: string;
  seat: string;
  round: number;
  model: string;
  chat_id: string | null;
  request_sha256: string | null;
  response_sha256: string | null;
  signature: string | null;
  signing_address: string | null;
  verified: boolean;
  move: unknown;
  /** Private until the game ends (ReceiptStore strips it before then). */
  reasoning: string | null;
  // ---- extras ----
  /** "model" when the model enclave signed, "gateway" when the NEAR AI gateway did, null if unknown. */
  signer?: "model" | "gateway" | null;
  /** Why the move came from the scripted fallback (no key, timeout, bad JSON, illegal move). */
  fallback?: string | null;
  /** What the persona said aloud with the move (public). */
  say?: string | null;
  /** The text the signature covers ("<request sha256>:<response sha256>"). */
  signed_text?: string | null;
  at_ms: number;
  /** Time for the NEAR AI completion, and for fetching + checking its signature. */
  inference_ms?: number;
  verify_ms?: number;
};

/** The exact bytes the hashes cover, kept beside the receipt so anyone can recheck it. */
export type Evidence = { chat_id: string; request_body: string; response_body: string };
