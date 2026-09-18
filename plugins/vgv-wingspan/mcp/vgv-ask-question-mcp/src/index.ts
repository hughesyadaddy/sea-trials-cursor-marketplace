#!/usr/bin/env node
/**
 * VGV structured-question MCP server.
 *
 * Tier 3 fallback when host tools are absent from the agent schema:
 * - Cursor: native `AskQuestion` (injected by the host on some models/modes)
 * - Claude Code: native `AskUserQuestion` (host tool, not MCP)
 *
 * This server's MCP form elicitation is **not** Cursor's native AskQuestion
 * picker. It uses the MCP `elicitInput` protocol where the client supports
 * it. Agents must never call this tool when host AskQuestion or
 * AskUserQuestion is available — check the tool schema first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const optionSchema = z.object({
  id: z.string(),
  label: z.string(),
});

const questionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  options: z.array(optionSchema).min(1),
  allow_multiple: z.boolean().optional(),
});

const inputSchema = {
  questions: z.array(questionSchema).min(1).max(4),
};

type Question = z.infer<typeof questionSchema>;

type AnswerEntry = {
  questionId: string;
  selectedOptionIds: string[];
};

type AnsweredPayload = {
  outcome: 'answered';
  answers: AnswerEntry[];
  answersById: Record<string, string | string[]>;
};

type FallbackPayload = {
  outcome: 'fallback';
  answersById: Record<string, never>;
  _fallbackText: string;
};

type CancelledPayload = {
  outcome: 'cancelled';
};

type ToolPayload = AnsweredPayload | FallbackPayload | CancelledPayload;

type ElicitResult =
  | { status: 'answered'; value: string | string[] }
  | { status: 'cancelled' }
  | { status: 'fallback' };

function toSelectedOptionIds(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function fallbackTextForQuestions(questions: Question[]): string {
  const blocks = questions.map((question, questionIndex) => {
    const lines = question.options.map(
      (option, index) => `${index + 1}. ${option.label} [${option.id}]`,
    );
    return [
      `Question ${questionIndex + 1} (${question.id}): ${question.prompt}`,
      ...lines,
    ].join('\n');
  });

  return [
    'HOST_QUESTION_TOOL_UNAVAILABLE',
    'MCP elicitation UI is unavailable — reply in chat.',
    ...blocks,
    'Reply with the option id, label, or number.',
  ].join('\n\n');
}

function schemaForQuestion(
  question: Question,
): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  if (question.allow_multiple) {
    return {
      type: 'object',
      properties: {
        choices: {
          type: 'array',
          title: question.prompt,
          items: {
            type: 'string',
            enum: question.options.map((option) => option.id),
          },
          minItems: 1,
        },
      },
      required: ['choices'],
    };
  }

  return {
    type: 'object',
    properties: {
      choice: {
        type: 'string',
        title: question.prompt,
        oneOf: question.options.map((option) => ({
          const: option.id,
          title: option.label,
        })),
      },
    },
    required: ['choice'],
  };
}

async function elicitAnswer(
  server: McpServer,
  question: Question,
): Promise<ElicitResult> {
  try {
    const result = await server.server.elicitInput({
      mode: 'form',
      message: question.prompt,
      // SDK schema types are stricter than our dynamic form builder.
      requestedSchema: schemaForQuestion(question) as never,
    });

    if (result.action === 'decline' || result.action === 'cancel') {
      return { status: 'cancelled' };
    }

    if (result.action !== 'accept' || !result.content) {
      return { status: 'fallback' };
    }

    const content = result.content as Record<string, unknown>;
    if (question.allow_multiple && Array.isArray(content.choices)) {
      return {
        status: 'answered',
        value: content.choices.map(String),
      };
    }
    if (typeof content.choice === 'string') {
      return { status: 'answered', value: content.choice };
    }
    return { status: 'fallback' };
  } catch {
    return { status: 'fallback' };
  }
}

function formatToolResponse(
  payload: ToolPayload,
  humanLines?: string,
): { content: Array<{ type: 'text'; text: string }> } {
  const json = JSON.stringify(payload, null, 2);
  const text =
    humanLines !== undefined && humanLines.length > 0
      ? `${humanLines}\n\n${json}`
      : json;

  return {
    content: [{ type: 'text', text }],
  };
}

const server = new McpServer(
  {
    name: 'vgv-ask-question',
    version: '1.1.0',
  },
  {
    capabilities: {},
  },
);

server.registerTool(
  'ask_user_question',
  {
    description:
      'Present up to 4 structured multiple-choice questions in one call. ' +
      'NEVER call this MCP tool when host AskQuestion (Cursor) or ' +
      'AskUserQuestion (Claude Code) exists in the agent tool schema — ' +
      'those host tools are always preferred. Use this MCP server only as ' +
      'tier 3 when both host tools are absent. MCP form elicitation is not ' +
      "Cursor's native AskQuestion picker.",
    inputSchema,
  },
  async ({ questions }) => {
    const answersById: Record<string, string | string[]> = {};
    const answers: AnswerEntry[] = [];

    for (const question of questions) {
      const elicited = await elicitAnswer(server, question);

      if (elicited.status === 'cancelled') {
        return formatToolResponse({ outcome: 'cancelled' });
      }

      if (elicited.status === 'fallback') {
        const fallbackText = fallbackTextForQuestions(questions);
        const humanLines = [
          'Structured question fallback.',
          'Host AskQuestion / AskUserQuestion unavailable;',
          'MCP elicitation also failed.',
          '',
          fallbackText,
        ].join('\n');

        return formatToolResponse(
          {
            outcome: 'fallback',
            answersById: {},
            _fallbackText: fallbackText,
          },
          humanLines,
        );
      }

      answersById[question.id] = elicited.value;
      answers.push({
        questionId: question.id,
        selectedOptionIds: toSelectedOptionIds(elicited.value),
      });
    }

    return formatToolResponse({
      outcome: 'answered',
      answers,
      answersById,
    });
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`vgv-ask-question-mcp failed: ${message}\n`);
  process.exit(1);
});
