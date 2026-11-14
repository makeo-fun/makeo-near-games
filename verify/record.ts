#!/usr/bin/env bun
// Records a real end-to-end fixture: attestation (fresh nonce) → one JSON completion → its signature.
//   NEAR_AI_API_KEY=… bun verify/record.ts      writes verify/fixtures/signature.json
// The test "a real recorded signature verifies" then checks it offline.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NearAiClient, DEFAULT_MODEL } from "../actors/src/nearai";
import { attest, checkSignature, fetchSignature } from "./nearai";

const apiKey = process.env.NEAR_AI_API_KEY;
if (!apiKey) throw new Error("set NEAR_AI_API_KEY");
const model = process.env.NEAR_AI_MODEL || DEFAULT_MODEL;
const attestation = await attest(model, { apiKey });
console.log("attestation ok:", attestation.ok, "gateway", attestation.gateway.address, "models", attestation.models.map((m) => m.address));
const client = new NearAiClient({ apiKey, model });
const c = await client.complete({ system: 'Answer with one JSON object: {"move": <number 1-3>, "reasoning": "<short>"}', user: "Pick a number." });
const record = await fetchSignature(c.chat_id, model, { apiKey });
const result = checkSignature({ record, model, requestBody: c.request_body, responseBody: c.response_body, attestation });
console.log("signature:", result.ok, result.signer, result.checks);
writeFileSync(join(import.meta.dir, "fixtures", "signature.json"), JSON.stringify({ model, record, request_body: c.request_body, response_body: c.response_body, attestation }, null, 2));
