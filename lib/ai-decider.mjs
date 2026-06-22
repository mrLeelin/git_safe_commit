export async function runAiToolLoop(options) {
  const {
    config,
    messages,
    tools,
    handlers,
    fetchImpl = globalThis.fetch,
    maxTurns = 12,
    onEvent = () => {}
  } = options;

  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  if (!config?.ai?.baseUrl || !config.ai.apiKey) {
    throw new Error("AI baseUrl and apiKey are required");
  }

  const conversation = [...messages];
  const toolResults = [];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const completion = await callChatCompletions({ config, messages: conversation, tools, fetchImpl });
    const message = completion.choices?.[0]?.message;
    if (!message) {
      throw new Error("AI response did not include choices[0].message");
    }

    conversation.push(message);
    const toolCalls = message.tool_calls || [];
    if (!toolCalls.length) {
      return {
        finalText: message.content || "",
        messages: conversation,
        toolResults
      };
    }

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name;
      const handler = handlers[name];
      if (!handler) {
        throw new Error(`no handler registered for AI tool: ${name}`);
      }
      const args = parseToolArguments(toolCall.function?.arguments || "{}");
      onEvent("ai-action", { tool: name, args });
      const result = await handler(args, toolCall);
      toolResults.push({ tool: name, args, result });
      conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(result)
      });
      onEvent("ai-result", { tool: name, result });
    }
  }

  throw new Error(`AI tool loop exceeded ${maxTurns} turns`);
}

async function callChatCompletions({ config, messages, tools, fetchImpl }) {
  const response = await fetchImpl(`${config.ai.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${config.ai.apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.ai.model,
      messages,
      tools,
      tool_choice: "auto",
      temperature: config.ai.temperature
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || `AI request failed: HTTP ${response.status}`);
  }
  return data;
}

function parseToolArguments(value) {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new Error(`invalid tool arguments JSON: ${error.message}`);
  }
}
