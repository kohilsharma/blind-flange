/**
 * `local`: real open-weight inference on this machine (ADR-0001), answering
 * from `llama-server` — llama.cpp's own HTTP server, MIT, run from a prebuilt
 * binary under `vendor/llama.cpp/`. Nothing is compiled and no Python binding
 * is involved: the upstream project already ships the server this needs, so
 * the whole of this provider is the client half.
 *
 * The server holds the model in memory between turns, so a turn pays for
 * generation only, not a multi-second model load.
 *
 * Ahead of the ADR-0001 day-4 stretch goal, and honest about what it is:
 *
 *   - **CPU by default.** The prebuilt `ubuntu-x64` build is a CPU build.
 *     GPU offload is a separate binary (the Vulkan build reaches this
 *     laptop's GTX 1650 Ti without a CUDA toolkit) and a separate licence
 *     question, so it is deliberately not bundled into this first pass.
 *   - **Not streaming.** One `{type:"text"}` yield per turn, which is the
 *     granularity `ReplayModelProvider` already emits, so `llm-adapter.js`
 *     sees nothing new. `stream: true` is a later change to this file alone.
 *   - **It answers; it does not act.** Only genuine human turns and prior
 *     assistant text are sent — tool calls, tool results and harness-injected
 *     context (skill catalog, system-prompt injection) are dropped. A 1.5B
 *     model has no use for an agentic tool schema it was never trained to
 *     call, and pretending otherwise would produce invented tool calls rather
 *     than an answer.
 *
 * `remote` stays unimplemented (ADR-0001): this reaches loopback only.
 */

import { ModelProviderError } from "./model-provider.js";

/** llama-server's OpenAI-compatible route. Loopback only — see ADR-0001 on `remote`. */
const DEFAULT_URL = "http://127.0.0.1:8790/v1/chat/completions";

const SYSTEM_PROMPT =
	"You are the local model inside Blind Flange, a sovereign air-gapped inspection workbench " +
	"for refinery engineers. Answer directly and concisely.";

/** Whether `message` is the genuine human turn, not a tool result or harness-injected context (mirrors replay-provider.js's own check). */
function isGenuineHumanMessage(message) {
	return message.role === "user" && (message.source === undefined || message.source.kind === "user");
}

/** A message's plain text, joining its text blocks; "" for one that carries none. */
function messageText(message) {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The plain chat history this provider can use: genuine human turns and the assistant text that answered them, in order. */
export function toChatMessages(messages) {
	const chat = [];
	for (const message of messages) {
		if (isGenuineHumanMessage(message)) {
			chat.push({ role: "user", content: messageText(message) });
		} else if (message.role === "assistant") {
			const text = messageText(message);
			if (text) chat.push({ role: "assistant", content: text });
		}
	}
	return chat;
}

export class LocalModelProvider {
	/** @param {string} [url] - override for tests; defaults to the local llama-server. */
	constructor(url = DEFAULT_URL) {
		this.url = url;
	}

	async *answer(request) {
		const chat = toChatMessages(request.messages);
		if (chat.length === 0 || chat.at(-1).role !== "user") {
			throw new ModelProviderError("the local model provider found no genuine user turn to answer");
		}

		let response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					messages: [{ role: "system", content: SYSTEM_PROMPT }, ...chat],
					max_tokens: 512,
					temperature: 0.3,
				}),
			});
		} catch (cause) {
			throw new ModelProviderError(
				`could not reach llama-server at ${this.url} — start it with \`npm run local-model\``,
				{ cause },
			);
		}
		if (!response.ok) {
			throw new ModelProviderError(`llama-server answered HTTP ${response.status}`);
		}
		const body = await response.json();
		yield { type: "text", text: body.choices?.[0]?.message?.content ?? "" };
	}
}
