export type Inference = { model: string; complete(prompt: { system: string; user: string }): Promise<{ chat_id: string; json: unknown; text: string; request_body: string; response_body: string }> };
