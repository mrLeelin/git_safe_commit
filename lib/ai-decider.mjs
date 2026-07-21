import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { getLogger } from "./logger.mjs";

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
      const logger = getLogger();
      logger?.info("ai", "", `AI 调用工具: ${name}`, summarizeToolArguments(args));
      const result = await handler(args, toolCall);
      logger?.info("ai", "", `AI 工具结果: ${name}`, {
        resultType: typeof result,
        resultOk: result?.ok
      });
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

const AiCommands = {
  codex: () => ["codex", ["--ask-for-approval", "never", "exec", "--sandbox", "read-only", "-"]],
  claude: () => ["claude", ["--print"]],
  gemini: () => ["gemini", ["--prompt", ""]]
};

export async function runAiToolLoopLocal(options) {
  const {
    config,
    messages,
    tools,
    handlers,
    runProcess,
    maxTurns = 12,
    onEvent = () => {}
  } = options;

  const selected = config?.ai?.selected || config?.ai?.activeProvider || "codex";
  const repoPath = config?.repoPath || process.cwd();

  const repoContext = await readRepoContext(repoPath);
  const toolDescriptions = buildToolDescriptions(tools);
  const systemMessage = messages.find((m) => m.role === "system");
  const userMessage = messages.find((m) => m.role === "user");
  const toolResults = [];

  const fullPrompt = [
    systemMessage?.content || "",
    repoContext,
    "",
    "## 可用工具",
    toolDescriptions,
    "",
    "当你需要调用工具时，输出一个 JSON 对象（不要包含其他内容）：",
    '{"tool": "工具名", "args": {参数}}',
    "工具执行后你会收到结果，根据结果决定下一步。",
    "当你完成所有操作后，直接输出最终文本（不要包含 JSON）。",
    "",
    "## 用户请求",
    userMessage?.content || ""
  ].join("\n");

  const [file, baseArgs] = AiCommands[selected]?.() || [];
  if (!file) throw new Error(`不支持的 AI：${selected}`);

  const command = resolveCliCommand(selected, file, baseArgs);
  let conversationText = "";

  for (let turn = 0; turn < maxTurns; turn += 1) {
    onEvent("ai-action", { tool: "local-cli", args: { turn } });

    const input = turn === 0 ? fullPrompt : [
      fullPrompt,
      "",
      "## 之前的对话",
      conversationText,
      "",
      "## 上一个工具结果",
      conversationText.includes("## 上一个工具结果")
        ? ""
        : "请根据上面的结果继续。如果操作完成，直接输出最终文本。"
    ].join("\n");

    const result = await runProcess(command.file, command.args, {
      cwd: repoPath,
      input,
      timeout: 180000,
      maxBuffer: 1024 * 1024 * 10,
      resolveOnStdoutIdleMs: selected === "codex" ? 1200 : 0
    });

    const output = (result.stdout || "").trim();
    onEvent("ai-result", { tool: "local-cli", result: { turn, outputLength: output.length } });

    const toolCall = extractJsonToolCall(output);

    if (!toolCall || !toolCall.tool) {
      return { finalText: output, messages, toolResults };
    }

    const handler = handlers[toolCall.tool];
    if (!handler) {
      conversationText += `\n\n工具 ${toolCall.tool} 不存在，请使用可用工具。`;
      continue;
    }

    onEvent("ai-action", { tool: toolCall.tool, args: toolCall.args });
    const logger = getLogger();
    logger?.info("ai-local", "", `AI 本地调用工具: ${toolCall.tool}`);
    const handlerResult = await handler(toolCall.args);
    logger?.info("ai-local", "", `AI 本地工具结果: ${toolCall.tool}`, { hasResult: !!handlerResult });
    toolResults.push({ tool: toolCall.tool, args: toolCall.args, result: handlerResult });
    onEvent("ai-result", { tool: toolCall.tool, result: handlerResult });

    conversationText += `\n\n我调用了 ${toolCall.tool}，结果：\n${JSON.stringify(handlerResult, null, 2)}`;
  }

  throw new Error(`AI local tool loop exceeded ${maxTurns} turns`);
}

function buildToolDescriptions(tools) {
  if (!Array.isArray(tools)) return "";
  return tools.map((tool) => {
    const fn = tool.function || tool;
    const params = fn.parameters?.properties || {};
    const required = fn.parameters?.required || [];
    const paramStr = Object.entries(params)
      .map(([name, schema]) => {
        const req = required.includes(name) ? "（必填）" : "（可选）";
        return `  - ${name}: ${schema.description || schema.type || "any"} ${req}`;
      })
      .join("\n");
    return `- ${fn.name}: ${fn.description}${paramStr ? "\n" + paramStr : ""}`;
  }).join("\n\n");
}

async function readRepoContext(repoPath) {
  const lines = [];
  const files = ["CLAUDE.md", "AGENTS.md"];
  for (const file of files) {
    const filePath = path.join(repoPath, file);
    if (existsSync(filePath)) {
      try {
        const content = await readFile(filePath, "utf8");
        if (content.trim()) {
          lines.push(`## ${file}\n${content.trim()}`);
        }
      } catch {}
    }
  }
  return lines.length ? lines.join("\n\n") : "";
}

function extractJsonToolCall(text) {
  const patterns = [
    /```json\s*(\{[\s\S]*?\})\s*```/,
    /```\s*(\{[\s\S]*?\})\s*`/,
    /(\{[\s\S]*?"tool"[\s\S]*?\})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      try { return JSON.parse(match[1]); } catch {}
    }
  }
  try {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{") && trimmed.includes('"tool"')) {
        return JSON.parse(trimmed);
      }
    }
  } catch {}
  return null;
}

function resolveCliCommand(selected, file, args) {
  if (process.platform === "win32") {
    const cmdShim = `${file}.cmd`;
    if (existsSync(cmdShim)) return { file: "cmd.exe", args: ["/d", "/s", "/c", cmdShim, ...args] };
    const psShim = `${file}.ps1`;
    if (existsSync(psShim)) return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psShim, ...args] };
  }
  return { file, args };
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

function summarizeToolArguments(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { argumentType: Array.isArray(args) ? "array" : typeof args };
  }
  return { argumentKeys: Object.keys(args).sort() };
}
