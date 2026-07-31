/**
 * Multi-agent orchestrator
 *
 * 管理流水线：主智能体（分解）→ 子智能体（执行）→ 最终智能体（合成）
 * 每个智能体都以 pi 子进程运行，使用 JSON 模式输出结构化结果。
 *
 * 中文输出：Todo 列表 + 思考过程实时显示
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  type AgentRunResult,
  type DecompositionResult,
  type ExtensionConfig,
  type ThinkingLevel,
  type ModelType,
  type TodoItem,
  type ThinkingStep,
  MODEL_LABELS,
} from "./types.ts";

const MAX_CONCURRENCY = 3;

/**
 * 模型名到 API 模型标识符的映射
 * flash → 轻量快速模型
 * pro   → 强大专业模型
 */
function resolveModelName(model: string): string {
  if (model === "flash") return "deepseek-chat";
  if (model === "pro") return "deepseek-reasoner";
  // 兼容旧配置
  return model;
}

// ─── System Prompts (中文) ──────────────────────────────────────────────────

const MAIN_AGENT_SYSTEM_PROMPT = `你是一个任务分解智能体。你的职责是分析复杂任务并将其拆解为清晰、可操作的子任务。

给定一个复杂任务后，你必须：
1. 彻底分析该任务
2. 判断任务是否需要拆分为子任务（针对复杂的多步骤工作），还是可以直接完成
3. 如果需要子任务，将其分解为 1-3 个清晰、独立的子任务
4. 返回结构化的 JSON 响应

你的响应必须是有效的 JSON，格式如下：
{
  "needsSubAgents": true/false,
  "reasoning": "对你的分解策略的简要解释",
  "subTasks": [
    "第一个具体的子任务描述",
    "第二个具体的子任务描述",
    "第三个具体的子任务描述（如需要）"
  ]
}

如果 needsSubAgents 为 false，subTasks 应为空数组。
保持子任务聚焦且可操作。每个子任务应能独立完成。`;

const SUB_AGENT_SYSTEM_PROMPT = `你是一个任务执行智能体。你收到一个特定的子任务，必须彻底执行它。

你的目标是：
1. 完全理解子任务
2. 使用可用工具（read、bash、grep、find、ls、edit、write）来完成任务
3. 提供详细的输出，包括你的发现、代码或实现
4. 在你的响应中做到全面且自包含

尽你所能完成分配的任务。如果需要更多上下文，请使用 read/grep/find 探索代码库。`;

const FINAL_AGENT_SYSTEM_PROMPT = `你是一个结果合成智能体。你的职责是接收来自多个专业智能体的输出，并将它们组合成连贯、全面的最终响应。

给定：
- 原始用户任务
- 任务分解和推理
- 每个子智能体的输出

你必须：
1. 将所有信息合成为连贯的响应
2. 解决智能体输出之间的任何不一致
3. 添加你自己的分析和联系
4. 以清晰、结构良好的格式呈现最终结果

专注于为最终用户提供价值——使最终响应完整且可操作。`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** Build env vars with provider auth passed to subprocess */
function buildAgentEnv(
  parentEnv: Record<string, string>,
  providerAuth?: ProviderAuth,
): Record<string, string> {
  const env: Record<string, string> = { ...parentEnv };

  if (providerAuth) {
    // Pass API key via the provider's canonical env var
    const knownEnvVars: Record<string, string> = {
      openai: "OPENAI_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      google: "GOOGLE_API_KEY",
      groq: "GROQ_API_KEY",
      together: "TOGETHER_API_KEY",
    };

    // Set the API key env var
    if (providerAuth.apiKey) {
      // Try known provider, or use generic
      const knownVar = knownEnvVars[providerAuth.providerId];
      if (knownVar) {
        env[knownVar] = providerAuth.apiKey;
      } else {
        env[`${providerAuth.providerId.toUpperCase()}_API_KEY`] = providerAuth.apiKey;
      }
    }

    // Set base URL if available
    if (providerAuth.baseUrl) {
      const knownUrlVars: Record<string, string> = {
        openai: "OPENAI_BASE_URL",
        deepseek: "DEEPSEEK_BASE_URL",
        anthropic: "ANTHROPIC_BASE_URL",
        google: "GOOGLE_BASE_URL",
      };
      const knownVar = knownUrlVars[providerAuth.providerId];
      if (knownVar) {
        env[knownVar] = providerAuth.baseUrl;
      }
    }
  }

  return env;
}

export interface ProviderAuth {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
}

// ─── Run a single agent via pi subprocess ───────────────────────────────────

async function runAgent(
  label: string,
  model: string,
  thinkingLevel: ThinkingLevel,
  systemPrompt: string,
  task: string,
  providerAuth: ProviderAuth | undefined,
  cwd: string,
  signal: AbortSignal | undefined,
  onThinkingStep?: (step: ThinkingStep) => void,
): Promise<AgentRunResult> {
  const realModel = resolveModelName(model);
  const modelLabel = MODEL_LABELS[model as ModelType] || model;

  const result: AgentRunResult = {
    label,
    model: realModel,
    thinkingLevel,
    task,
    output: "",
    success: false,
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    thinkingSteps: [],
  };

  const args: string[] = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", realModel,
    "--thinking", thinkingLevel,
  ];

  // Build env with provider auth
  const env = buildAgentEnv(
    Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, v ?? ""])),
    providerAuth,
  );

  let tmpPromptPath: string | null = null;
  let tmpPromptDir: string | null = null;

  try {
    // Write system prompt to temp file
    if (systemPrompt.trim()) {
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-multi-agent-"));
      tmpPromptDir = tmpDir;
      const safeName = label.replace(/[^\w.-]+/g, "_");
      const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
      await withFileMutationQueue(filePath, async () => {
        await fs.promises.writeFile(filePath, systemPrompt, {
          encoding: "utf-8",
          mode: 0o600,
        });
      });
      tmpPromptPath = filePath;
      args.push("--append-system-prompt", filePath);
    }

    // 记录思考步骤：开始
    addThinkingStep(result, `🧠 ${label} 开始工作...`, `模型: ${modelLabel}, 思考级别: ${thinkingLevel}`);
    if (onThinkingStep) {
      onThinkingStep({
        timestamp: Date.now(),
        step: `${label} 启动`,
        detail: `模型=${modelLabel}, 思考级别=${thinkingLevel}`,
      });
    }

    args.push(`Task: ${task}`);

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: env,
      });

      let buffer = "";
      let fullOutput = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          fullOutput += line + "\n";
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          if (msg.role === "assistant") {
            if (result.usage) result.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              result.usage!.input += usage.input || 0;
              result.usage!.output += usage.output || 0;
              result.usage!.cost += usage.cost?.total || 0;
            }
            if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === "text") {
                  fullOutput += part.text;
                }
              }
            } else if (typeof msg.content === "string") {
              fullOutput += msg.content;
            }
          }
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (_data) => {
        // ignore stderr
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        result.output = fullOutput.trim();
        result.success = code === 0 && fullOutput.trim().length > 0;
        resolve(code ?? 1);
      });

      proc.on("error", (err) => {
        result.error = `进程错误: ${err.message}`;
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    // 记录思考步骤：完成
    if (result.success) {
      addThinkingStep(result, `✅ ${label} 完成`, `输出长度: ${result.output.length} 字符`);
      if (onThinkingStep) {
        onThinkingStep({
          timestamp: Date.now(),
          step: `${label} 完成`,
          detail: `输出长度=${result.output.length}`,
        });
      }
    } else {
      addThinkingStep(result, `❌ ${label} 失败`, result.error || `退出码 ${exitCode}`);
      if (onThinkingStep) {
        onThinkingStep({
          timestamp: Date.now(),
          step: `${label} 失败`,
          detail: result.error || `退出码 ${exitCode}`,
        });
      }
    }

    if (exitCode !== 0 && !result.error) {
      result.error = `进程退出码 ${exitCode}`;
    }
  } finally {
    if (tmpPromptPath) {
      try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
    }
    if (tmpPromptDir) {
      try { fs.rmdirSync(tmpPromptDir); } catch { /* ignore */ }
    }
  }

  return result;
}

/** 添加思考步骤到结果中 */
function addThinkingStep(result: AgentRunResult, step: string, detail?: string): void {
  if (!result.thinkingSteps) result.thinkingSteps = [];
  result.thinkingSteps.push({
    timestamp: Date.now(),
    step,
    detail,
  });
}

/** 添加 Todo 项到结果中 */
function addTodoItem(
  result: AgentRunResult,
  id: number,
  description: string,
  status: TodoItem["status"],
): void {
  if (!result.todoList) result.todoList = [];
  // 更新已存在的项，或添加新项
  const existing = result.todoList.find((t) => t.id === id);
  if (existing) {
    existing.status = status;
    if (description) existing.description = description;
  } else {
    result.todoList.push({ id, description, status });
  }
}

// ─── Parse decomposition from main agent output ─────────────────────────────

function parseDecomposition(output: string): DecompositionResult {
  const jsonMatch = output.match(/\{[\s\S]*"needsSubAgents"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        needsSubAgents: parsed.needsSubAgents ?? true,
        subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks.slice(0, 3) : [],
        reasoning: parsed.reasoning || "",
      };
    } catch {
      // JSON parse failed
    }
  }

  // Fallback: try to extract sub-tasks from numbered list
  const lines = output.split("\n");
  const subTasks: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.+)/);
    if (match) {
      subTasks.push(match[1].trim());
    }
  }

  return {
    needsSubAgents: subTasks.length > 0,
    subTasks: subTasks.slice(0, 3),
    reasoning: subTasks.length > 0 ? "主智能体提供了任务分解。" : output,
  };
}

// ─── Run parallel tasks with concurrency limit ──────────────────────────────

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

// ─── Main orchestrator entry point ──────────────────────────────────────────

export interface OrchestrationOptions {
  config: ExtensionConfig;
  task: string;
  cwd: string;
  /** Provider auth resolved from pi's provider auth system */
  providerAuth?: ProviderAuth;
  signal?: AbortSignal;
  onUpdate?: (partial: AgentToolResult<any>) => void;
}

export interface OrchestrationResult {
  finalOutput: string;
  mainAgentResult: AgentRunResult;
  subAgentResults: AgentRunResult[];
  finalAgentResult: AgentRunResult;
  decomposition: DecompositionResult;
}

export async function orchestrate(
  options: OrchestrationOptions,
): Promise<OrchestrationResult> {
  const { config, task, cwd, providerAuth, signal, onUpdate } = options;

  const emitUpdate = (phase: string, detail: string, todoList?: TodoItem[], thinkingSteps?: ThinkingStep[]) => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: `[${phase}] ${detail}` }],
        details: { phase, detail, todoList, thinkingSteps },
      });
    }
  };

  // ── Phase 1: Main Agent decomposes the task ────────────────────────────
  emitUpdate("主智能体", "正在分析和分解任务...");

  const mainResult = await runAgent(
    config.mainAgent.label,
    config.mainAgent.model,
    config.mainAgent.thinkingLevel,
    config.mainAgent.systemPrompt || MAIN_AGENT_SYSTEM_PROMPT,
    task,
    providerAuth,
    cwd,
    signal,
    (step) => {
      emitUpdate("主智能体", step.step, undefined, [step]);
    },
  );

  // 记录主智能体的思考过程
  if (mainResult.thinkingSteps) {
    for (const step of mainResult.thinkingSteps) {
      emitUpdate("主智能体", step.step, undefined, [step]);
    }
  }

  if (!mainResult.success) {
    return {
      finalOutput: `主智能体失败: ${mainResult.error || "未知错误"}`,
      mainAgentResult: mainResult,
      subAgentResults: [],
      finalAgentResult: {
        label: config.finalAgent.label,
        model: config.finalAgent.model,
        thinkingLevel: config.finalAgent.thinkingLevel,
        task: "",
        output: "",
        success: false,
        error: "主智能体失败，无法继续",
      },
      decomposition: { needsSubAgents: false, subTasks: [], reasoning: "" },
    };
  }

  const decomposition = parseDecomposition(mainResult.output);
  emitUpdate("主智能体", `分解完成: ${decomposition.reasoning}`);

  // ── Phase 2: Execute sub-tasks ─────────────────────────────────────────
  const subAgentResults: AgentRunResult[] = [];

  if (decomposition.needsSubAgents && decomposition.subTasks.length > 0) {
    const subTasks = decomposition.subTasks.slice(0, 3);

    // 构建 Todo 列表
    const todoList: TodoItem[] = subTasks.map((st, i) => ({
      id: i + 1,
      description: st,
      status: "pending" as const,
    }));

    emitUpdate(
      "子智能体",
      `启动 ${subTasks.length} 个子智能体 (${config.parallelExecution ? "并行" : "串行"})...`,
      todoList,
    );

    if (config.parallelExecution) {
      const results = await mapWithConcurrencyLimit(
        subTasks,
        MAX_CONCURRENCY,
        async (subTask, index) => {
          // 更新 Todo: running
          todoList[index].status = "running";
          emitUpdate(
            "子智能体",
            `子智能体 #${index + 1} 开始执行: ${subTask.slice(0, 60)}...`,
            [...todoList],
          );

          const agentConfig = config.subAgents[index] || config.subAgents[0];
          const agResult = await runAgent(
            `${agentConfig.label} (#${index + 1})`,
            agentConfig.model,
            agentConfig.thinkingLevel,
            agentConfig.systemPrompt || SUB_AGENT_SYSTEM_PROMPT,
            subTask,
            providerAuth,
            cwd,
            signal,
            (step) => {
              emitUpdate("子智能体", `#${index + 1}: ${step.step}`, undefined, [step]);
            },
          );

          // 更新 Todo: done/failed
          todoList[index].status = agResult.success ? "done" : "failed";
          emitUpdate(
            "子智能体",
            `子智能体 #${index + 1} "${agResult.label}": ${agResult.success ? "完成" : "失败"}` +
              (agResult.usage ? ` (↑${formatTokens(agResult.usage.input)} ↓${formatTokens(agResult.usage.output)})` : ""),
            [...todoList],
          );

          return agResult;
        },
      );
      subAgentResults.push(...results);
    } else {
      for (let i = 0; i < subTasks.length; i++) {
        // 更新 Todo: running
        todoList[i].status = "running";
        emitUpdate(
          "子智能体",
          `子智能体 #${i + 1} 开始执行: ${subTasks[i].slice(0, 60)}...`,
          [...todoList],
        );

        const agentConfig = config.subAgents[i] || config.subAgents[0];
        const agResult = await runAgent(
          `${agentConfig.label} (#${i + 1})`,
          agentConfig.model,
          agentConfig.thinkingLevel,
          agentConfig.systemPrompt || SUB_AGENT_SYSTEM_PROMPT,
          subTasks[i],
          providerAuth,
          cwd,
          signal,
          (step) => {
            emitUpdate("子智能体", `#${i + 1}: ${step.step}`, undefined, [step]);
          },
        );

        // 更新 Todo: done/failed
        todoList[i].status = agResult.success ? "done" : "failed";
        emitUpdate(
          "子智能体",
          `子智能体 #${i + 1}: ${agResult.success ? "完成" : "失败"}` +
            (agResult.usage ? ` (↑${formatTokens(agResult.usage.input)} ↓${formatTokens(agResult.usage.output)})` : ""),
          [...todoList],
        );

        subAgentResults.push(agResult);
        if (signal?.aborted) break;
      }
    }
  } else {
    emitUpdate("子智能体", "无需子任务，跳过子智能体。");
  }

  // ── Phase 3: Final Agent synthesizes results ──────────────────────────
  emitUpdate("最终智能体", "正在合成所有结果...");

  const synthesisTask = buildSynthesisTask(task, decomposition, subAgentResults);
  const finalResult = await runAgent(
    config.finalAgent.label,
    config.finalAgent.model,
    config.finalAgent.thinkingLevel,
    config.finalAgent.systemPrompt || FINAL_AGENT_SYSTEM_PROMPT,
    synthesisTask,
    providerAuth,
    cwd,
    signal,
    (step) => {
      emitUpdate("最终智能体", step.step, undefined, [step]);
    },
  );

  emitUpdate("最终智能体", finalResult.success ? "合成完成" : "合成失败");

  return {
    finalOutput: finalResult.output || "(最终智能体无输出)",
    mainAgentResult: mainResult,
    subAgentResults,
    finalAgentResult: finalResult,
    decomposition,
  };
}

// ─── Build synthesis task from all results ──────────────────────────────────

function buildSynthesisTask(
  originalTask: string,
  decomposition: DecompositionResult,
  subAgentResults: AgentRunResult[],
): string {
  let prompt = `## 原始用户任务\n\n${originalTask}\n\n`;

  if (decomposition.reasoning) {
    prompt += `## 任务分解推理\n\n${decomposition.reasoning}\n\n`;
  }

  if (subAgentResults.length > 0) {
    prompt += `## 子智能体输出\n\n`;
    for (let i = 0; i < subAgentResults.length; i++) {
      const r = subAgentResults[i];
      prompt += `### 子任务 ${i + 1}: ${r.task}\n\n`;
      if (r.success) {
        prompt += `${r.output}\n\n`;
      } else {
        prompt += `(失败: ${r.error || "未知"})\n\n`;
      }
    }
  } else {
    prompt += "未使用子智能体。主智能体直接处理了任务。\n\n";
  }

  prompt += `## 合成说明\n\n请将以上信息合成为一份全面、结构良好的最终响应。合并所有发现，解决任何不一致，并提供完整的答案。`;

  return prompt;
}
