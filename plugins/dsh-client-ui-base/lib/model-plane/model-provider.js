/**
 * The `ModelProvider` contract (ADR-0001; CONTEXT.md "Model plane"): our own
 * interface, not the harness's. Everything behind it is a swap, never a
 * rewrite. Three names are selectable — `replay`, `local`, `remote` — and
 * which one runs is a configuration value read once in `createModelProvider`,
 * never a code path (FR7). The harness-facing bridge lives in
 * `llm-adapter.js`; nothing in this file knows the harness exists.
 */

import { LocalModelProvider } from "./local-provider.js";
import { ReplayModelProvider } from "./replay-provider.js";

/** Thrown when a configured provider name has no implementation to select, or when a selected provider cannot answer. */
export class ModelProviderError extends Error {
	constructor(message) {
		super(message);
		this.name = "ModelProviderError";
	}
}

/**
 * `remote` is a rented GPU or API — a development convenience only.
 * ADR-0001 is explicit that it must never be the active provider during a
 * demo or a recording, and nothing in this repo is licensed to reach a
 * network endpoint outside a test (NFR15-17), so it stays unimplemented.
 */
class RemoteModelProvider {
	// Always throws before any yield; the generator shape is the contract other providers meet.
	async *answer() {
		throw new ModelProviderError("the remote model provider is a development convenience this build does not configure (ADR-0001)");
	}
}

const FACTORIES = {
	replay: () => new ReplayModelProvider(),
	/** `url` lets a profile point at a llama-server elsewhere — see `local-provider.js` on the GPU build. */
	local: (options) => new LocalModelProvider(options?.url),
	remote: () => new RemoteModelProvider(),
};

/**
 * Select a `ModelProvider` by name. The one place ADR-0001's "selected by
 * configuration, never by a code path" is enforced: every caller reaches a
 * provider through this lookup, never by importing `ReplayModelProvider` (or
 * a future local/remote implementation) directly.
 * The request a provider is handed mirrors the harness's own `GenerateOptions`
 * (`@deepseek-ai/dsh-llm`), narrowed to what a provider can act on. A provider
 * may ignore any field — `replay` reads only `messages` — but the fields are
 * passed rather than dropped, because `tools` is what makes real tool calling
 * possible at all and a provider cannot ask for it later.
 *
 * A provider yields pieces, not harness chunks: `{ type: "text", text }` or
 * `{ type: "tool-call", id, name, arguments }` where `arguments` is a raw JSON
 * **string**. `llm-adapter.js` turns those into the harness's block protocol.
 *
 * @param {string} name - one of "replay", "local", "remote".
 * @param {{ url?: string }} [options] - provider-specific configuration, read from
 *   `config.modelPlane` so the endpoint stays a config value rather than a code path (FR7).
 * @returns {{ answer(request: {
 *   messages: unknown[],
 *   tools?: { name: string, description: string, parameters: Record<string, unknown> }[],
 *   model?: string,
 *   system?: string,
 *   sessionId?: string,
 *   signal?: AbortSignal,
 * }): AsyncGenerator<{ type: "text", text: string } | { type: "tool-call", id: string, name: string, arguments: string }> }}
 */
export function createModelProvider(name, options) {
	const factory = FACTORIES[name];
	if (!factory) {
		throw new ModelProviderError(`unknown model provider "${name}" — expected one of: ${Object.keys(FACTORIES).join(", ")}`);
	}
	return factory(options);
}
