// Public API of the actor runner. Games import types from here; tools import the rest.
export type { GameActor, Persona, Prompt, Receipt, Evidence } from "./types";
export { PERSONAS, pickPersonas, lineFor, personaPreamble } from "./personas";
export { MockRoom, serveMockRoom, seeded, type MockGame } from "./mock-room";
export { HttpTransport, type RoomTransport, type RoomInfo, type Envelope, type Ack } from "./transport";
export { ActorSeat, runActors, type ResponseVerifier } from "./runner";
export { ReceiptStore } from "./receipts";
export { NearAiClient, nearAiFromEnv, scriptedInference, extractJson, DEFAULT_MODEL, type Inference } from "./nearai";
export { createSeat, type SeatSigner } from "./seat";
export { HumanSeat } from "./human";
