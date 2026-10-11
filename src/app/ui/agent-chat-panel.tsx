"use client";

import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { DefaultChatTransport } from "ai";
import { useChat } from "@ai-sdk/react";
import type { AgentId } from "../../agent-catalog.ts";
import type { AgentChatUIMessage } from "../../analysis-progress.ts";

type AgentChatPanelProps = {
  agentId: AgentId;
  agentName: string;
  active: boolean;
};

export function AgentChatPanel({ agentId, agentName, active }: AgentChatPanelProps) {
  const [input, setInput] = useState("");
  const pendingDraft = useRef<string | null>(null);
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/agent-chat", body: { agentId } }), [agentId]);
  const { messages, sendMessage, status, error } = useChat<AgentChatUIMessage>({
    transport,
    onError: () => {
      // The chat SDK reports request failures here without rejecting sendMessage.
      if (pendingDraft.current !== null) setInput(pendingDraft.current);
    },
  });
  const busy = status === "submitted" || status === "streaming";

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy || pendingDraft.current !== null) return;
    pendingDraft.current = text;
    setInput("");
    try {
      await sendMessage({ text });
    } catch {
      setInput(text);
    } finally {
      pendingDraft.current = null;
    }
  }

  return (
    <section className="agent-chat" aria-label={`${agentName} chat`} hidden={!active}>
      <div className="agent-chat-header">
        <div><span className="section-kicker">ROLE CHAT</span><h3>Chat with {agentName}</h3></div>
        <span className="chat-ready"><i /> {busy ? "Responding" : "Ready"}</span>
      </div>
      <p className="agent-chat-note">This chat uses the agent’s role and your messages. It does not include the current repository report automatically.</p>
      <div className="agent-chat-messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="chat-empty"><span>Ask about this agent’s role or paste code and review context to discuss.</span></div>
        ) : messages.map((message) => {
          const text = message.parts.filter((part) => part.type === "text").map((part) => part.text).join("");
          const route = message.parts.find((part) => part.type === "data-agentRouting");
          if (!text && !route) return null;
          return (
            <div className="chat-message-group" key={message.id}>
              {route && <div className="chat-route"><strong>{route.data.delegated ? "Planner delegation" : "Selected agent"}</strong><span>{route.data.delegated ? `Planner → ${route.data.targetAgentName} → Planner` : route.data.targetAgentName}</span><small>{route.data.rationale}</small></div>}
              {text && <div className={`chat-message ${message.role}`}><span>{message.role === "user" ? "You" : agentName}</span><p>{text}</p></div>}
            </div>
          );
        })}
        {busy && <div className="chat-thinking"><span className="spinner" /> Thinking…</div>}
        {error && <div className="chat-error">{error.message}</div>}
      </div>
      <form className="agent-chat-form" onSubmit={submitMessage}>
        <label className="sr-only" htmlFor={`chat-${agentId}`}>Message {agentName}</label>
        <textarea id={`chat-${agentId}`} value={input} onChange={(event) => setInput(event.target.value)} placeholder={`Ask ${agentName}…`} rows={2} maxLength={8000} disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()}>Send <span>↗</span></button>
      </form>
    </section>
  );
}
