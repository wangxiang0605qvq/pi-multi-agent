/**
 * Shared types for the pi-multi-agent extension
 *
 * (中文注释：pi-multi-agent 扩展的共享类型)
 */

/** 模型类型：仅支持 flash(快速) 和 pro(专业) 两种 */
export type ModelType = "flash" | "pro";

/** Todo 列表项 */
export interface TodoItem {
  /** 序号 */
  id: number;
  /** 任务描述 */
  description: string;
  /** 状态: pending(待办) | running(执行中) | done(完成) | failed(失败) */
  status: "pending" | "running" | "done" | "failed";
}

/** 思考步骤 */
export interface ThinkingStep {
  /** 时间戳 */
  timestamp: number;
  /** 步骤描述 */
  step: string;
  /** 详细内容 (可选) */
  detail?: string;
}

/** 单个智能体的运行状态 */
export interface AgentRunStatus {
  label: string;
  model: string;
  /** Todo 列表 */
  todoList: TodoItem[];
  /** 思考过程 */
  thinkingSteps: ThinkingStep[];
  /** 当前阶段文本 */
  currentPhase: string;
}

/** Configuration for a single agent */
export interface AgentConfig {
  /** Display label for the agent (e.g. "主智能体", "子智能体 1") */
  label: string;
  /** The model identifier - only "flash" or "pro" */
  model: ModelType;
  /** Thinking level */
  thinkingLevel: ThinkingLevel;
  /** System prompt override (optional) */
  systemPrompt?: string;
}

/** Thinking level options */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Full extension configuration */
export interface ExtensionConfig {
  /** Main agent config (task decomposition) */
  mainAgent: AgentConfig;
  /** 3 sub-agents (task execution) */
  subAgents: [AgentConfig, AgentConfig, AgentConfig];
  /** Final agent config (result synthesis) */
  finalAgent: AgentConfig;
  /** Whether sub-agents run in parallel (true) or sequence (false) */
  parallelExecution: boolean;
  /** Max tokens for agent responses */
  maxTokens: number;
}

/** Result from a single agent run */
export interface AgentRunResult {
  /** Agent label */
  label: string;
  /** Model used */
  model: string;
  /** Thinking level used */
  thinkingLevel: ThinkingLevel;
  /** The task given to this agent */
  task: string;
  /** The output text */
  output: string;
  /** Whether the run succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Usage stats */
  usage?: {
    input: number;
    output: number;
    cost: number;
    turns: number;
  };
  /** 思考过程 */
  thinkingSteps?: ThinkingStep[];
  /** Todo 列表 */
  todoList?: TodoItem[];
}

/** Decomposition result from main agent */
export interface DecompositionResult {
  /** Whether sub-agents are needed */
  needsSubAgents: boolean;
  /** Array of sub-tasks for sub-agents */
  subTasks: string[];
  /** Reasoning from main agent */
  reasoning: string;
}

/** 模型显示标签映射 */
export const MODEL_LABELS: Record<ModelType, string> = {
  flash: "Flash (快速)",
  pro: "Pro (专业)",
};

/** Default configuration */
export const DEFAULT_CONFIG: ExtensionConfig = {
  mainAgent: {
    label: "主智能体 (任务分解)",
    model: "flash",
    thinkingLevel: "high",
    systemPrompt: "",
  },
  subAgents: [
    {
      label: "子智能体 1",
      model: "pro",
      thinkingLevel: "high",
      systemPrompt: "",
    },
    {
      label: "子智能体 2",
      model: "pro",
      thinkingLevel: "high",
      systemPrompt: "",
    },
    {
      label: "子智能体 3",
      model: "pro",
      thinkingLevel: "high",
      systemPrompt: "",
    },
  ],
  finalAgent: {
    label: "最终智能体 (结果合成)",
    model: "pro",
    thinkingLevel: "max",
    systemPrompt: "",
  },
  parallelExecution: true,
  maxTokens: 8192,
};

/** Thinking level options for UI selection */
export const THINKING_LEVEL_OPTIONS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** 模型选项列表 (仅 flash 和 pro) */
export const MODEL_OPTIONS: ModelType[] = ["flash", "pro"];
