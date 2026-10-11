"use client";

import { useState } from "react";
import type { AgentId } from "../../agent-catalog.ts";
import { AGENT_CATALOG } from "../../agent-catalog.ts";
import { AgentChatPanel } from "./agent-chat-panel";

export function AgentWorkspace() {
  const [selectedAgentId, setSelectedAgentId] = useState<AgentId>("red-zone-agent");

  return (
    <div className="agents-layout">
      <div className="agent-roster" role="group" aria-label="Choose an agent to chat with">
        {AGENT_CATALOG.map((agent) => (
          <button className={`agent-roster-item ${selectedAgentId === agent.id ? "selected" : ""}`} type="button" aria-pressed={selectedAgentId === agent.id} key={agent.id} onClick={() => setSelectedAgentId(agent.id)}>
            <span className="agent-avatar">{agent.shortName.slice(0, 1)}</span>
            <span className="agent-roster-copy"><strong>{agent.name}</strong><small>{agent.description}</small></span>
            <span className="agent-state ready">Ready</span>
          </button>
        ))}
      </div>
      <div className="agent-chat-panels">
        {AGENT_CATALOG.map((agent) => <AgentChatPanel key={agent.id} agentId={agent.id} agentName={agent.name} active={selectedAgentId === agent.id} />)}
      </div>
    </div>
  );
}
