#!/usr/bin/env node
/**
 * VGV structured-question MCP server.
 *
 * Claude Code exposes AskUserQuestion as a host tool (not MCP). Cursor exposes
 * AskQuestion the same way. This server is tier 3: when neither host tool
 * exists, agents call ask_user_question here. When the client supports MCP
 * form elicitation, the user gets a native picker; otherwise the tool returns
 * a compact numbered fallback for chat.
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

function fallbackText(question: Question): string {
  const lines = question.options.map(
    (option, index) => `${index + 1}. ${option.label} [${option.id}]`,
  );
  return [
    'HOST_QUESTION_TOOL_UNAVAILABLE',
    `Question (${question.id}): ${question.prompt}`,
    ...lines,
    'Reply with the option id, label, or number.',
  ].join('\n');
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
): Promise<string | string[] | null> {
  try {
    const result = await server.server.elicitInput({
      mode: 'form',
      message: question.prompt,
      // SDK schema types are stricter than our dynamic form builder.
      requestedSchema: schemaForQuestion(question) as never,
    });

    if (result.action !== 'accept' || !result.content) {
      return null;
    }

    const content = result.content as Record<string, unknown>;
    if (question.allow_multiple && Array.isArray(content.choices)) {
      return content.choices.map(String);
    }
    if (typeof content.choice === 'string') {
      return content.choice;
    }
    return null;
  } catch {
    return null;
  }
}

const server = new McpServer(
  {
    name: 'vgv-ask-question',
    version: '1.0.0',
  },
  {
    capabilities: {},
  },
);

server.registerTool(
  'ask_user_question',
  {
    description:
      'Present structured multiple-choice questions to the user. Prefer host ' +
      'AskQuestion (Cursor) or AskUserQuestion (Claude Code) when available. ' +
      'Use this MCP tool only when those host tools are absent from the schema.',
    inputSchema,
  },
  async ({ questions }) => {
    const answers: Record<string, string | string[]> = {};

    for (const question of questions) {
      const elicited = await elicitAnswer(server, question);
      if (elicited !== null) {
        answers[question.id] = elicited;
        continue;
      }

      return {
        content: [
          {
            type: 'text',
            text: fallbackText(question),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ answers }, null, 2),
        },
      ],
    };
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
