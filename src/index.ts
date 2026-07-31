/**
 * pi-multi-agent 扩展
 *
 * 多智能体编排扩展，用于 pi 编码智能体。
 * - 主智能体（低成本模型）：分解复杂任务
 * - 最多 3 个子智能体：并行或串行执行子任务
 * - 最终智能体（强大模型）：合成所有结果
 *
 * API Key 自动从 pi 的 provider 认证系统中获取，无需单独配置。
 * 通过 TUI 的 /multi-agent 命令进行配置。
 *
 * 中文界面：显示 Todo 列表和思考过程
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  type ExtensionConfig,
  type ModelType,
  type TodoItem,
  type ThinkingStep,
  DEFAULT_CONFIG,
  MODEL_LABELS,
} from "./types.ts";
import { loadConfig, saveConfig, showConfigUI } from "./config.ts";
import { orchestrate, type OrchestrationResult, type ProviderAuth } from "./orchestrator.ts";

/** Try to resolve provider auth from pi's model registry */
function resolveProviderAuth(ctx: any): ProviderAuth | undefined {
  try {
    // Try to get the current model's provider auth
    const currentModel = ctx.model;
    if (currentModel) {
      const providerId = currentModel.provider || "deepseek";
      const auth = ctx.modelRegistry?.getProviderAuth?.(providerId);
      if (auth) {
        return {
          providerId,
          apiKey: auth.apiKey || auth.api_key,
          baseUrl: auth.baseUrl || auth.base_url,
        };
      }
    }

    // Fallback: try common provider IDs
    for (const providerId of ["deepseek", "openai", "openrouter"]) {
      try {
        const auth = ctx.modelRegistry?.getProviderAuth?.(providerId);
        if (auth?.apiKey) {
          return {
            providerId,
            apiKey: auth.apiKey || auth.api_key,
            baseUrl: auth.baseUrl || auth.base_url,
          };
        }
      } catch {
        // Try next provider
      }
    }
  } catch {
    // Cannot resolve auth
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  let config: ExtensionConfig = { ...DEFAULT_CONFIG };

  /** Todo 列表状态图标 */
  function todoStatusIcon(status: TodoItem["status"]): string {
    switch (status) {
      case "pending": return "⬜";
      case "running": return "🔄";
      case "done": return "✅";
      case "failed": return "❌";
    }
  }

  /** 构建 Todo 列表的文本渲染 */
  function renderTodoList(todoList: TodoItem[], theme: any): string {
    if (!todoList || todoList.length === 0) return "";
    const lines: string[] = [theme.fg("muted", "─── 📋 待办列表 (Todo List) ───")];
    for (const item of todoList) {
      const icon = todoStatusIcon(item.status);
      const desc = item.description.length > 80
        ? item.description.slice(0, 80) + "..."
        : item.description;
      lines.push(`  ${icon} ${desc}`);
    }
    return lines.join("\n");
  }

  /** 构建思考过程的文本渲染 */
  function renderThinkingSteps(steps: ThinkingStep[] | undefined, theme: any): string {
    if (!steps || steps.length === 0) return "";
    const lines: string[] = [theme.fg("muted", "─── 💭 思考过程 (Thinking Process) ───")];
    // 只显示最近的若干条
    const recent = steps.slice(-6);
    for (const step of recent) {
      const time = new Date(step.timestamp).toLocaleTimeString("zh-CN");
      lines.push(`  ${theme.fg("dim", time)} ${step.step}`);
      if (step.detail) {
        const detail = step.detail.length > 70
          ? step.detail.slice(0, 70) + "..."
          : step.detail;
        lines.push(`    ${theme.fg("dim", detail)}`);
      }
    }
    return lines.join("\n");
  }

  // ── Helper: format agent run result for display ─────────────────────────
  function formatAgentRun(r: {
    label: string;
    model: string;
    thinkingLevel: string;
    success: boolean;
    usage?: { input: number; output: number; cost: number; turns: number };
  }): string {
    const status = r.success ? "✅" : "❌";
    const usage = r.usage
      ? ` ↑${r.usage.input} ↓${r.usage.output} ¥${r.usage.cost.toFixed(4)} (${r.usage.turns} 轮)`
      : "";
    return `${status} ${r.label} [${r.model}, 思考=${r.thinkingLevel}]${usage}`;
  }

  // ── Register /multi-agent command for configuration ─────────────────────
  pi.registerCommand("multi-agent", {
    description: "配置多智能体设置（模型、思考级别）",
    handler: async (_args, ctx) => {
      config = loadConfig(ctx);
      const changed = await showConfigUI(ctx, config);
      if (changed) {
        saveConfig(config, pi);
        ctx.ui.notify("🧠 多智能体配置已保存！", "success");
      } else {
        ctx.ui.notify("未做更改", "info");
      }
    },
  });

  // ── Register the multi_agent tool for LLM usage ─────────────────────────
  pi.registerTool({
    name: "multi_agent",
    label: "多智能体",
    description: [
      "使用多智能体流水线分解复杂任务：",
      "1. 主智能体（轻量模型）分析和分解任务",
      "2. 最多 3 个子智能体并行或串行执行子任务",
      "3. 最终智能体（强大模型）合成所有结果",
      "适用于需要并行探索的复杂多步骤任务。",
      "简单任务应直接处理，无需使用此工具。",
      "API Key 自动从 pi 的 provider 配置中获取。",
    ].join(" "),

    parameters: Type.Object({
      task: Type.String({
        description: "需要委托给多智能体流水线的复杂任务",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Load latest config
      config = loadConfig(ctx);

      // Resolve auth from pi's provider system
      const providerAuth = resolveProviderAuth(ctx as any);

      if (!providerAuth?.apiKey) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ 在 pi 的 provider 配置中未找到 API Key。\n\n请先在 pi 中使用 `/login` 配置 provider，或设置相应的环境变量（如 `DEEPSEEK_API_KEY`）。\n\n然后运行 `/multi-agent` 配置模型设置。",
            },
          ],
          details: { configError: true },
        };
      }

      const task = params.task as string;

      // Run orchestration
      const result: OrchestrationResult = await orchestrate({
        config,
        task,
        cwd: ctx.cwd,
        providerAuth,
        signal,
        onUpdate,
      });

      // Build summary
      const summaryLines: string[] = [];
      summaryLines.push(formatAgentRun(result.mainAgentResult));
      for (const sr of result.subAgentResults) {
        summaryLines.push(formatAgentRun(sr));
      }
      summaryLines.push(formatAgentRun(result.finalAgentResult));

      const summary = summaryLines.join("\n");

      // Calculate total cost
      const totalCost =
        (result.mainAgentResult.usage?.cost || 0) +
        result.subAgentResults.reduce((s, r) => s + (r.usage?.cost || 0), 0) +
        (result.finalAgentResult.usage?.cost || 0);

      return {
        content: [
          {
            type: "text",
            text: result.finalOutput || "(无输出)",
          },
        ],
        details: {
          summary,
          totalCost,
          mainAgent: {
            label: result.mainAgentResult.label,
            model: result.mainAgentResult.model,
            thinkingLevel: result.mainAgentResult.thinkingLevel,
            success: result.mainAgentResult.success,
            usage: result.mainAgentResult.usage,
            output: result.mainAgentResult.output,
            thinkingSteps: result.mainAgentResult.thinkingSteps,
            todoList: result.mainAgentResult.todoList,
          },
          decomposition: result.decomposition,
          subAgents: result.subAgentResults.map((r) => ({
            label: r.label,
            model: r.model,
            thinkingLevel: r.thinkingLevel,
            success: r.success,
            usage: r.usage,
            output: r.output,
            thinkingSteps: r.thinkingSteps,
            todoList: r.todoList,
          })),
          finalAgent: {
            label: result.finalAgentResult.label,
            model: result.finalAgentResult.model,
            thinkingLevel: result.finalAgentResult.thinkingLevel,
            success: result.finalAgentResult.success,
            usage: result.finalAgentResult.usage,
            output: result.finalAgentResult.output,
            thinkingSteps: result.finalAgentResult.thinkingSteps,
            todoList: result.finalAgentResult.todoList,
          },
        },
      };
    },

    // ── Render the tool call in TUI ───────────────────────────────────────
    renderCall(args, theme, _context) {
      const task = (args.task as string) || "...";
      const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
      const text =
        theme.fg("toolTitle", theme.bold("multi_agent ")) +
        theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    // ── Render the tool result in TUI ─────────────────────────────────────
    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as any;
      if (!details || details.configError) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(无输出)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      if (expanded) {
        const container = new Container();

        // Title
        container.addChild(
          new Text(theme.fg("toolTitle", theme.bold("🧠 多智能体流水线结果")), 0, 0),
        );
        container.addChild(new Spacer(1));

        // ── Main agent section ───────────────────────────────────────────
        container.addChild(
          new Text(theme.fg("muted", "─── 主智能体（任务分解） ───"), 0, 0),
        );
        if (details.mainAgent) {
          const ma = details.mainAgent;
          const icon = ma.success ? theme.fg("success", "✅") : theme.fg("error", "❌");
          const modelLabel = MODEL_LABELS[ma.model as ModelType] || ma.model;
          container.addChild(
            new Text(`${icon} ${theme.fg("accent", modelLabel)} ${theme.fg("dim", `思考=${ma.thinkingLevel}`)}`, 0, 0),
          );

          // 显示 Todo 列表
          if (ma.todoList && ma.todoList.length > 0) {
            container.addChild(new Text(theme.fg("muted", "📋 待办列表:"), 0, 0));
            for (const item of ma.todoList) {
              const statusIcon = item.status === "done" ? "✅" :
                item.status === "failed" ? "❌" :
                item.status === "running" ? "🔄" : "⬜";
              const desc = item.description.length > 70
                ? item.description.slice(0, 70) + "..."
                : item.description;
              container.addChild(new Text(`  ${statusIcon} ${desc}`, 0, 0));
            }
          }

          // 显示思考过程
          if (ma.thinkingSteps && ma.thinkingSteps.length > 0) {
            container.addChild(new Text(theme.fg("muted", "💭 思考过程:"), 0, 0));
            for (const step of ma.thinkingSteps) {
              const time = new Date(step.timestamp).toLocaleTimeString("zh-CN");
              container.addChild(new Text(`  ${theme.fg("dim", time)} ${step.step}`, 0, 0));
              if (step.detail) {
                const detail = step.detail.length > 70
                  ? step.detail.slice(0, 70) + "..."
                  : step.detail;
                container.addChild(new Text(`    ${theme.fg("dim", detail)}`, 0, 0));
              }
            }
          }

          if (details.decomposition?.reasoning) {
            container.addChild(
              new Text(theme.fg("dim", `推理: ${details.decomposition.reasoning}`), 0, 0),
            );
          }
          if (details.decomposition?.subTasks?.length > 0) {
            container.addChild(new Text(theme.fg("muted", "子任务列表:"), 0, 0));
            for (const st of details.decomposition.subTasks) {
              container.addChild(new Text(`  ${theme.fg("dim", "·")} ${st}`, 0, 0));
            }
          }
        }
        container.addChild(new Spacer(1));

        // ── Sub-agents section ───────────────────────────────────────────
        if (details.subAgents?.length > 0) {
          container.addChild(
            new Text(theme.fg("muted", `─── 子智能体 (${details.subAgents.length} 个) ───`), 0, 0),
          );
          for (const sa of details.subAgents) {
            const icon = sa.success ? theme.fg("success", "✅") : theme.fg("error", "❌");
            const modelLabel = MODEL_LABELS[sa.model as ModelType] || sa.model;
            const usageStr = sa.usage
              ? theme.fg("dim", ` ↑${sa.usage.input} ↓${sa.usage.output} ¥${sa.usage.cost.toFixed(4)}`)
              : "";
            container.addChild(
              new Text(`  ${icon} ${theme.fg("accent", sa.label)} (${modelLabel})${usageStr}`, 0, 0),
            );

            // 显示子智能体的 Todo
            if (sa.todoList && sa.todoList.length > 0) {
              for (const item of sa.todoList) {
                const statusIcon = item.status === "done" ? "✅" :
                  item.status === "failed" ? "❌" : "⬜";
                const desc = item.description.length > 60
                  ? item.description.slice(0, 60) + "..."
                  : item.description;
                container.addChild(new Text(`    ${statusIcon} ${desc}`, 0, 0));
              }
            }

            // 显示子智能体的思考过程
            if (sa.thinkingSteps && sa.thinkingSteps.length > 0) {
              for (const step of sa.thinkingSteps.slice(-3)) { // 只显示最近 3 条
                const time = new Date(step.timestamp).toLocaleTimeString("zh-CN");
                container.addChild(new Text(`    ${theme.fg("dim", time)} ${step.step}`, 0, 0));
              }
            }

            if (sa.output) {
              container.addChild(new Markdown(sa.output.trim().slice(0, 500), 2, 0, mdTheme));
            }
          }
          container.addChild(new Spacer(1));
        }

        // ── Final agent section ──────────────────────────────────────────
        container.addChild(
          new Text(theme.fg("muted", "─── 最终智能体（结果合成） ───"), 0, 0),
        );
        if (details.finalAgent) {
          const fa = details.finalAgent;
          const icon = fa.success ? theme.fg("success", "✅") : theme.fg("error", "❌");
          const modelLabel = MODEL_LABELS[fa.model as ModelType] || fa.model;
          container.addChild(
            new Text(`${icon} ${theme.fg("accent", modelLabel)} ${theme.fg("dim", `思考=${fa.thinkingLevel}`)}`, 0, 0),
          );

          // 显示最终智能体的思考过程
          if (fa.thinkingSteps && fa.thinkingSteps.length > 0) {
            container.addChild(new Text(theme.fg("muted", "💭 思考过程:"), 0, 0));
            for (const step of fa.thinkingSteps) {
              const time = new Date(step.timestamp).toLocaleTimeString("zh-CN");
              container.addChild(new Text(`  ${theme.fg("dim", time)} ${step.step}`, 0, 0));
            }
          }

          container.addChild(new Spacer(1));
          if (fa.output) {
            container.addChild(new Markdown(fa.output.trim(), 0, 0, mdTheme));
          }
        }

        // Cost summary
        if (details.totalCost !== undefined) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              theme.fg("dim", `总费用: ¥${details.totalCost.toFixed(4)}`),
              0,
              0,
            ),
          );
        }

        return container;
      }

      // Collapsed view - show summary + todo + thinking
      let text = "";
      if (details.summary) {
        text += details.summary + "\n\n";
      }

      // Show todo list from sub-agents in collapsed view
      if (details.subAgents) {
        for (const sa of details.subAgents) {
          if (sa.todoList && sa.todoList.length > 0) {
            text += `📋 ${sa.label}:\n`;
            for (const item of sa.todoList) {
              const statusIcon = item.status === "done" ? "✅" :
                item.status === "failed" ? "❌" :
                item.status === "running" ? "🔄" : "⬜";
              text += `  ${statusIcon} ${item.description.slice(0, 60)}\n`;
            }
          }
        }
      }

      text += theme.fg("dim", "(Ctrl+O 展开详情)");
      return new Text(text, 0, 0);
    },
  });

  // ── Restore config on session start ─────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = loadConfig(ctx);
  });
}
