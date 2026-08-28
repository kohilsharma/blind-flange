/**
 * `local`: real open-weight inference on this machine (ADR-0001), answering
 * from `llama-server` — llama.cpp's own HTTP server, MIT, run from a prebuilt
 * binary under `vendor/llama.cpp/`. Nothing is compiled and no Python binding
 * is involved: the upstream project already ships the server this needs, so
 * the whole of this provider is the client half.
 *
 * The server holds models in memory between turns, so a turn pays for
 * generation only, not a model load. In router mode (`--models-dir`) it holds
 * several at once and picks per request from the `model` field, which is what
 * makes the router's choice mean something — see `answer()`.
 *
 * **It calls tools for real.** `options.tools` carries the JSON schema of every
 * tool the agent can see; those go to the model in OpenAI's `tools` shape, and
 * `tool_calls` coming back become `tool-call` pieces the adapter turns into the
 * harness's block protocol. The harness then dispatches the call for real,
 * appends the result, and calls back in for the next step — this file only ever
 * supplies the model's half of that loop, exactly as the replay provider does.
 *
 * Honest about what it still is not:
 *
 *   - **CPU.** The prebuilt `ubuntu-x64` build is a CPU build, and it is the
 *     one that runs here: WSL2 exposes CUDA but no Vulkan ICD (verified
 *     29 Aug 2026 — `/usr/share/vulkan/icd.d/` carries Mesa drivers only), and
 *     llama.cpp publishes no prebuilt Linux CUDA binary. GPU offload would mean
 *     compiling from source.
 *   - **Not streaming.** One request, one response, pieces yielded at the end.
 *     That is the granularity `ReplayModelProvider` already emits, so
 *     `llm-adapter.js` sees nothing new. `stream: true` is a later change to
 *     this file alone.
 *
 * `remote` stays unimplemented (ADR-0001): this reaches loopback only.
 */

import { routedWeightsFor } from "../router/selection.js";
import { ModelProviderError } from "./model-provider.js";

/** llama-server's OpenAI-compatible route. Loopback only — see ADR-0001 on `remote`. */
const DEFAULT_URL = "http://127.0.0.1:8790/v1/chat/completions";

/** Whether `message` is the genuine human turn, not harness-injected context (mirrors replay-provider.js's own check). */
function isGenuineHumanMessage(message) {
	return message.role === "user" && (message.source === undefined || message.source.kind === "user");
}

/** Whether `message` is a tool-result message (`role: "user"`, `source.kind: "tool"`). */
function isToolResult(message) {
	return message.role === "user" && message.source?.kind === "tool";
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

/**
 * The conversation in OpenAI chat shape, including the agentic history.
 *
 * Every turn of the tool loop has to survive this translation or the model
 * cannot see what it already did: an assistant message carrying `tool-call`
 * blocks becomes one with `tool_calls`, and each harness tool result — a
 * `user`-role message with `source.kind: "tool"` — becomes a `role: "tool"`
 * message keyed by the same call id. Drop either and the model re-issues the
 * call it already made, forever.
 *
 * Harness-injected `user`-role context (skill catalog, runtime snapshots,
 * session-title calls) is still dropped: it is not conversation, and
 * `isGenuineHumanMessage` is the same filter the replay provider applies.
 */
export function toChatMessages(messages) {
	const chat = [];
	for (const message of messages) {
		if (isToolResult(message)) {
			for (const block of Array.isArray(message.content) ? message.content : []) {
				if (block.type !== "tool-result") continue;
				const text = (Array.isArray(block.content) ? block.content : [])
					.filter((inner) => inner.type === "text")
					.map((inner) => inner.text)
					.join("\n");
				chat.push({ role: "tool", tool_call_id: block.toolCallId, content: text });
			}
			continue;
		}
		if (isGenuineHumanMessage(message)) {
			chat.push({ role: "user", content: messageText(message) });
			continue;
		}
		if (message.role !== "assistant") continue;

		const toolCalls = (Array.isArray(message.content) ? message.content : [])
			.filter((block) => block.type === "tool-call")
			.map((block) => ({
				id: block.id,
				type: "function",
				function: { name: block.name, arguments: block.arguments },
			}));
		const text = messageText(message);
		if (toolCalls.length > 0) {
			chat.push({ role: "assistant", content: text, tool_calls: toolCalls });
		} else if (text) {
			chat.push({ role: "assistant", content: text });
		}
	}
	return chat;
}

/**
 * Harness tool schemas in the OpenAI `tools` shape.
 *
 * `ToolSchema.parameters` is already a JSON Schema object, so it passes through
 * untouched — the same one-to-one mapping the harness's own DeepSeek adapter
 * makes.
 */
export function toOpenAiTools(tools) {
	return (tools ?? []).map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}

export class LocalModelProvider {
	/** @param {string} [url] - override for tests; defaults to the local llama-server. */
	constructor(url = DEFAULT_URL) {
		this.url = url;
	}

	async *answer(request) {
		const chat = toChatMessages(request.messages);
		if (chat.length === 0) {
			throw new ModelProviderError("the local model provider found no genuine user turn to answer");
		}

		// The harness's assembled system prompt, not one of our own invention —
		// it carries the Blind Flange persona the profile sets.
		const messages = request.system ? [{ role: "system", content: request.system }, ...chat] : chat;
		const tools = toOpenAiTools(request.tools);
		// The fleet member the router picked for this session, resolved to the
		// weights file it declares. The router's choice wins; the session's
		// configured default (`agent-default-model.model`) is the fallback for a
		// call the router never saw, such as session-title generation.
		const model = routedWeightsFor(request.sessionId) ?? request.model;

		let response;
		try {
			response = await fetch(this.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: request.signal,
				body: JSON.stringify({
					// Names the model llama-server should answer with. In router mode
					// (`--models-dir`) this is how one server serves the whole fleet;
					// with a single `-m` model it is ignored, so sending it is safe
					// either way.
					...(model ? { model } : {}),
					messages,
					...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
					max_tokens: 1024,
					temperature: 0.3,
				}),
			});
		} catch (cause) {
			if (cause?.name === "AbortError") throw cause;
			throw new ModelProviderError(
				`could not reach llama-server at ${this.url} — start it with \`npm run local-model\``,
				{ cause },
			);
		}
		if (!response.ok) {
			throw new ModelProviderError(`llama-server answered HTTP ${response.status}`);
		}

		const body = await response.json();
		const choice = body.choices?.[0]?.message ?? {};

		if (choice.content) yield { type: "text", text: choice.content };

		for (const call of choice.tool_calls ?? []) {
			// `arguments` stays the raw JSON string the model produced. The harness
			// parses it, and preserves it verbatim when it does not parse, so a
			// small model's malformed call comes back as a correctable tool error
			// rather than being silently repaired here.
			yield {
				type: "tool-call",
				id: call.id ?? `local-call-${call.index ?? 0}`,
				name: call.function?.name ?? "",
				arguments: call.function?.arguments ?? "{}",
			};
		}
	}
}
