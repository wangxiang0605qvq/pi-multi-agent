/**
 * Configuration management for pi-multi-agent extension
 *
 * 提供基于 TUI 的中文配置界面，用于设置智能体、模型和思考级别。
 * API Key 自动从 pi 的 provider 认证系统中获取。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  Text,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  type AgentConfig,
  type ExtensionConfig,
  type ThinkingLevel,
  type ModelType,
  DEFAULT_CONFIG,
  THINKING_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  MODEL_LABELS,
} from "./types.ts";

/** Storage key for persistent config */
const CONFIG_STORAGE_KEY = "pi-multi-agent-config";

/** 思考级别显示标签 (中文) */
const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中等",
  high: "高",
  xhigh: "非常高",
  max: "最高",
};

/**
 * Load config from session storage
 */
export function loadConfig(ctx: ExtensionContext): ExtensionConfig {
  try {
    const entries = ctx.sessionManager.getEntries();
    // Find the latest config entry
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as any;
      if (entry.type === "custom" && entry.customType === CONFIG_STORAGE_KEY && entry.data) {
        return { ...DEFAULT_CONFIG, ...entry.data };
      }
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to session storage
 */
export function saveConfig(config: ExtensionConfig, pi: any): void {
  pi.appendEntry(CONFIG_STORAGE_KEY, config);
}

/**
 * 显示多智能体配置界面
 * 如果配置被修改则返回 true
 */
export async function showConfigUI(ctx: ExtensionContext, config: ExtensionConfig): Promise<boolean> {
  // Make a mutable copy
  const workingConfig: ExtensionConfig = JSON.parse(JSON.stringify(config));
  let changed = false;

  while (true) {
    const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("🧠 多智能体配置")), 1, 0));
      container.addChild(new Text(theme.fg("dim", "配置智能体、模型和思考级别"), 1, 0));
      container.addChild(new Text(theme.fg("dim", "API Key 自动从 pi 的 provider 认证中获取"), 1, 0));
      container.addChild(new Text(" ", 0, 0));

      const updatedMenu: SelectItem[] = [
        {
          value: "main",
          label: "主智能体 (任务分解)",
          description: `模型: ${MODEL_LABELS[workingConfig.mainAgent.model as ModelType] || workingConfig.mainAgent.model} | 思考: ${THINKING_LABELS[workingConfig.mainAgent.thinkingLevel]}`,
        },
        {
          value: "sub1",
          label: "子智能体 1",
          description: `模型: ${MODEL_LABELS[workingConfig.subAgents[0].model as ModelType] || workingConfig.subAgents[0].model} | 思考: ${THINKING_LABELS[workingConfig.subAgents[0].thinkingLevel]}`,
        },
        {
          value: "sub2",
          label: "子智能体 2",
          description: `模型: ${MODEL_LABELS[workingConfig.subAgents[1].model as ModelType] || workingConfig.subAgents[1].model} | 思考: ${THINKING_LABELS[workingConfig.subAgents[1].thinkingLevel]}`,
        },
        {
          value: "sub3",
          label: "子智能体 3",
          description: `模型: ${MODEL_LABELS[workingConfig.subAgents[2].model as ModelType] || workingConfig.subAgents[2].model} | 思考: ${THINKING_LABELS[workingConfig.subAgents[2].thinkingLevel]}`,
        },
        {
          value: "final",
          label: "最终智能体 (结果合成)",
          description: `模型: ${MODEL_LABELS[workingConfig.finalAgent.model as ModelType] || workingConfig.finalAgent.model} | 思考: ${THINKING_LABELS[workingConfig.finalAgent.thinkingLevel]}`,
        },
        {
          value: "advanced",
          label: "高级设置",
          description: `并行: ${workingConfig.parallelExecution ? "是" : "否"} | 最大 Token: ${workingConfig.maxTokens}`,
        },
        { value: "save", label: "💾 保存并退出", description: "保存配置" },
        { value: "exit", label: "❌ 不保存退出", description: "放弃更改" },
      ];

      const menuList = new SelectList(updatedMenu, Math.min(updatedMenu.length, 10), {
        selectedPrefix: (t) => theme.fg("accent", t),
        selectedText: (t) => theme.fg("accent", t),
        description: (t) => theme.fg("muted", t),
        scrollInfo: (t) => theme.fg("dim", t),
        noMatch: (t) => theme.fg("warning", t),
      });

      menuList.onSelect = (item) => done(item.value);
      menuList.onCancel = () => done(null);
      container.addChild(menuList);

      container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • 回车 选择 • Esc 取消"), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => {
          menuList.handleInput(data);
          tui.requestRender();
        },
      };
    });

    if (!choice || choice === "exit") break;

    switch (choice) {
      case "main":
        await configureAgent(ctx, workingConfig.mainAgent);
        break;
      case "sub1":
        await configureAgent(ctx, workingConfig.subAgents[0]);
        break;
      case "sub2":
        await configureAgent(ctx, workingConfig.subAgents[1]);
        break;
      case "sub3":
        await configureAgent(ctx, workingConfig.subAgents[2]);
        break;
      case "final":
        await configureAgent(ctx, workingConfig.finalAgent);
        break;
      case "advanced":
        await configureAdvanced(ctx, workingConfig);
        break;
      case "save":
        Object.assign(config, workingConfig);
        changed = true;
        return true;
    }
  }

  return changed;
}

/**
 * 配置单个智能体的模型和思考级别
 */
async function configureAgent(ctx: ExtensionContext, agent: AgentConfig): Promise<void> {
  // 先选择模型 (仅 flash / pro)
  const modelItems: SelectItem[] = MODEL_OPTIONS.map((m) => ({
    value: m,
    label: MODEL_LABELS[m],
    description: m === "flash" ? "快速模型，适合简单任务分解" : "专业模型，适合复杂推理和代码生成",
  }));

  const selectedModel = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`选择模型 - "${agent.label}"`)), 1, 0));
    container.addChild(new Text(" ", 0, 0));

    const selectList = new SelectList(modelItems, Math.min(modelItems.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • 回车 选择 • Esc 取消"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (selectedModel) {
    agent.model = selectedModel as ModelType;
  }

  // 然后选择思考级别
  const thinkingItems: SelectItem[] = THINKING_LEVEL_OPTIONS.map((level) => ({
    value: level,
    label: THINKING_LABELS[level],
    description: getThinkingDescription(level),
  }));

  const selectedLevel = await ctx.ui.custom<ThinkingLevel | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(`思考级别 - "${agent.label}"`)), 1, 0));
    container.addChild(new Text(theme.fg("dim", `模型: ${MODEL_LABELS[agent.model as ModelType] || agent.model}`), 1, 0));
    container.addChild(new Text(" ", 0, 0));

    const selectList = new SelectList(thinkingItems, Math.min(thinkingItems.length, 10), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });

    selectList.onSelect = (item) => done(item.value as ThinkingLevel);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • 回车 选择 • Esc 取消"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (selectedLevel) {
    agent.thinkingLevel = selectedLevel;
    ctx.ui.notify(
      `${agent.label}: 模型=${MODEL_LABELS[agent.model as ModelType] || agent.model}, 思考=${THINKING_LABELS[selectedLevel]}`,
      "info",
    );
  }
}

/**
 * 配置高级设置
 */
async function configureAdvanced(ctx: ExtensionContext, config: ExtensionConfig): Promise<void> {
  await ctx.ui.custom<undefined>((tui, theme, _kb, done) => {
    const items: SettingItem[] = [
      {
        id: "parallel",
        label: "并行执行",
        currentValue: config.parallelExecution ? "是" : "否",
        values: ["是", "否"],
      },
      {
        id: "maxTokens",
        label: "最大 Token",
        currentValue: String(config.maxTokens),
        values: [],
      },
    ];

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold("高级设置")), 1, 0));
    container.addChild(new Text(" ", 0, 0));

    const settingsList = new SettingsList(
      items,
      8,
      getSettingsListTheme(),
      async (id, value) => {
        if (id === "parallel") {
          config.parallelExecution = value === "是";
          ctx.ui.notify(`并行执行: ${value}`, "info");
        } else if (id === "maxTokens") {
          const newTokens = await ctx.ui.input("请输入最大 Token 数:", String(config.maxTokens));
          if (newTokens) {
            const parsed = parseInt(newTokens, 10);
            if (!isNaN(parsed) && parsed > 0) {
              config.maxTokens = parsed;
              ctx.ui.notify(`最大 Token: ${parsed}`, "info");
            }
          }
        }
      },
      () => done(undefined),
    );

    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "↑↓ 导航 • 回车 切换/编辑 • Esc 返回"), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (w) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data) => settingsList.handleInput?.(data),
    };
  });
}

/** 获取思考级别的中文描述 */
function getThinkingDescription(level: ThinkingLevel): string {
  const descriptions: Record<ThinkingLevel, string> = {
    off: "不进行扩展思考",
    minimal: "最少的推理步骤",
    low: "较低的推理力度",
    medium: "平衡的推理",
    high: "深入的推理",
    xhigh: "非常深入的推理",
    max: "最大推理深度",
  };
  return descriptions[level];
}
