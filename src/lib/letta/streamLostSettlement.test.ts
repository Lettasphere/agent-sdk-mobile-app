import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@letta-ai/letta-agent-sdk/client";

// See terminalContract.test.ts for why the stub must register first.
await import("../../../test/stubNativeModules");

const { ChatSession } = await import("./ChatSession");
const { emptyChat } = await import("./model");

/**
 * Contract tests for the stream_lost settlement window (the follow-up to
 * PR #74's terminal doctrine): a local turn whose stream dies mid-run has an
 * UNKNOWN outcome — onTurnCompleted is DEFERRED (the MOBILE_ONLY one-shot
 * stays armed) until a settling signal arrives:
 *   1. loop_status IDLE on the recovering stream
 *   2. a definitive (non-stream_closed) result frame
 *   3. the REST tail reconcile observing the run terminal
 * Exactly-once: no settling signal path may fire it twice, and traffic
 * during the window must not be misclassified as an external run.
 */

const profile = { id: "p1", type: "cloud", name: "T", url: "https://api.letta.com" } as never;

function armedSession(): { chat: ChatSession; completions: unknown[] } {
  const chat = new ChatSession({ profile, secret: "k" }, "conv-t", "agent-t");
  const completions: unknown[] = [];
  chat.onTurnCompleted = (success) => completions.push(success);
  chat.onExternalRunCompleted = (success) => completions.push(`EXTERNAL:${success}`);
  // Real precondition: a turn sent from this app (send() sets this flag;
  // reduceForTest bypasses send, so set the private field directly).
  (chat as unknown as { localRunInFlight: boolean }).localRunInFlight = true;
  return { chat, completions };
}

/** Drive: in-flight local turn → stream_lost result (the deferral trigger). */
function loseStream(chat: ChatSession): void {
  chat.reduceForTest({ ...emptyChat, run: "running" }, {
    type: "result",
    success: false,
    errorCode: "stream_closed",
    recoverable: true,
    runIds: ["run-1"],
    conversationId: null,
    durationMs: 100,
  } as unknown as SDKMessage);
}

describe("stream_lost settlement", () => {
  test("a stream_lost local turn does NOT fire onTurnCompleted immediately", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    expect(completions).toEqual([]);
  });

  test("loop_status IDLE settles it exactly once, inconclusively", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    chat.reduceForTest(chat.current(), { type: "loop_status", status: "IDLE", activeRunIds: [] });
    expect(completions).toEqual([true]); // null outcome → success !== false
    // A second IDLE must not re-fire.
    chat.reduceForTest(chat.current(), { type: "loop_status", status: "IDLE", activeRunIds: [] });
    expect(completions).toEqual([true]);
  });

  test("a definitive result frame settles with its real outcome", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    chat.reduceForTest(chat.current(), {
      type: "result",
      success: true,
      conversationId: null,
      durationMs: 1,
    } as unknown as SDKMessage);
    expect(completions).toEqual([true]);
    // The local callback can't fire again from a duplicate result — but a
    // post-settlement result with no local flag IS external semantics, so
    // the duplicate routes there (reduce-level behavior, same as pre-loss).
    chat.reduceForTest(chat.current(), {
      type: "result",
      success: false,
      errorCode: "llm_api_error",
      conversationId: null,
      durationMs: 1,
    } as unknown as SDKMessage);
    expect(completions).toEqual([true, "EXTERNAL:false"]);
  });

  test("a definitive FAILED result settles as failure", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    chat.reduceForTest(chat.current(), {
      type: "result",
      success: false,
      errorCode: "llm_api_error",
      errorDetail: "boom",
      conversationId: null,
      durationMs: 1,
    } as unknown as SDKMessage);
    expect(completions).toEqual([false]);
  });

  test("a second stream_lost result while unsettled keeps waiting", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    chat.reduceForTest(chat.current(), {
      type: "result",
      success: false,
      errorCode: "stream_closed",
      recoverable: true,
      conversationId: null,
      durationMs: 1,
    } as unknown as SDKMessage);
    expect(completions).toEqual([]);
    // Then settles normally.
    chat.reduceForTest(chat.current(), { type: "loop_status", status: "IDLE", activeRunIds: [] });
    expect(completions).toEqual([true]);
  });

  test("deltas during the window do NOT fire the external-run callback at IDLE", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    // The recovering run's traffic (no local flag set — that's the window):
    chat.reduceForTest(chat.current(), { type: "assistant", id: "a1", content: "partial" } as unknown as SDKMessage);
    chat.reduceForTest(chat.current(), { type: "loop_status", status: "IDLE", activeRunIds: [] });
    // Exactly one completion (the settlement), zero external callbacks.
    expect(completions).toEqual([true]);
  });

  test("after settlement, results with no local flag return to external semantics", () => {
    const { chat, completions } = armedSession();
    loseStream(chat);
    chat.reduceForTest(chat.current(), { type: "loop_status", status: "IDLE", activeRunIds: [] });
    expect(completions).toEqual([true]);
    // Window closed: a later result with no local turn is another client's —
    // the external callback fires (reduce-level semantics restored).
    chat.reduceForTest(chat.current(), {
      type: "result", success: true, conversationId: null, durationMs: 1,
    } as unknown as SDKMessage);
    expect(completions).toEqual([true, "EXTERNAL:true"]);
  });
});
