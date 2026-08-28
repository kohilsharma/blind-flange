/**
 * What the router decided, so the model plane can act on it.
 *
 * The router classifies a request and scores the fleet in `agent/pre-step`
 * (`lib/index.js`), and until now that decision only ever reached the session
 * log — the routing chip displayed a real, recorded choice that had no effect
 * on which model answered. On `replay` that was harmless. On `local` it made
 * the chip name a member that did not generate the text, which is exactly the
 * failure ADR-0002 calls a bug rather than a shortcut.
 *
 * This is the one-way channel that closes it: the router records its already-
 * made decision here, keyed by session, and `LocalModelProvider` reads it to
 * name the model llama-server should answer with.
 *
 * **One decision, recorded once, used once.** The provider deliberately does
 * not re-run `classifyRequest`/`scoreFleet` on the messages it receives. A
 * second evaluation could disagree with the one already written to the session
 * log, and then the chip would be lying again in a subtler and harder-to-see
 * way.
 */

/**
 * sessionId -> the weights id of the fleet member the router picked.
 *
 * ponytail: unbounded Map, one small string per session seen this process.
 * A demo opens a handful of sessions and the harness restarts between runs, so
 * an eviction policy would be more code than the leak it prevents. Add an LRU
 * if this ever runs as a long-lived multi-tenant service.
 */
const weightsBySession = new Map();

/**
 * Record the member the router selected for this session's next turn.
 * @param {string | undefined} sessionId
 * @param {string | undefined} weights - the member's `weights` field from registry/models.yaml.
 */
export function recordRoutedWeights(sessionId, weights) {
	if (!sessionId || !weights) return;
	weightsBySession.set(String(sessionId), weights);
}

/**
 * The weights id the router last chose for this session, if any.
 *
 * Returns `undefined` when the router never ran (an auxiliary call such as
 * session-title generation), when scoring failed, or when the selected member
 * declares no `weights`. The provider then sends no `model` field at all and
 * llama-server answers with whatever it has loaded — the same behaviour as
 * before this existed, rather than a hard failure.
 * @param {string | undefined} sessionId
 * @returns {string | undefined}
 */
export function routedWeightsFor(sessionId) {
	if (!sessionId) return undefined;
	return weightsBySession.get(String(sessionId));
}
