#!/usr/bin/env node
/**
 * VGV structured-question MCP server (tier 3).
 *
 * Cursor host AskQuestion / Claude AskUserQuestion are NOT callable from MCP.
 * They are injected into the agent tool schema by the host (model-gated —
 * e.g. Composer 2.5 yes, Grok 4.5 no). This server only:
 *   1) MCP form elicitation when the client advertises it
 *   2) Numbered text fallback when elicitation fails
 *
 * See: https://cursor.com/docs/cli/acp (cursor/ask_question)
 *      https://cursor.com/docs/mcp (Elicitation supported)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
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

function log(message: string): void {
  process.stderr.write(`vgv-ask-question-mcp: ${message}\n`);
}

function fallbackText(questions: Question[]): string {
  const blocks = questions.map((question) => {
    const lines = question.options.map(
      (option, index) => `${index + 1}. ${option.label} [${option.id}]`,
    );
    return [
      `Question (${question.id}): ${question.prompt}`,
      ...lines,
      'Reply with the option id, label, or number.',
    ].join('\n');
  });

  return [
    'HOST_QUESTION_TOOL_UNAVAILABLE',
    'AskQuestion is a Cursor host tool (model-gated). Pin Composer 2.5 / Claude / GPT — not Auto or Grok 4.5 — for the native picker.',
    'MCP elicitation did not render a form; falling back to chat options:',
    ...blocks,
  ].join('\n\n');
}

/** Cursor-friendly legacy enum schema (enum + enumNames). */
function schemaForQuestions(questions: Question[]): {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const question of questions) {
    required.push(question.id);
    if (question.allow_multiple) {
      properties[question.id] = {
        type: 'array',
        title: question.prompt,
        minItems: 1,
        items: {
          type: 'string',
          enum: question.options.map((option) => option.id),
        },
      };
    } else {
      properties[question.id] = {
        type: 'string',
        title: question.prompt,
        enum: question.options.map((option) => option.id),
        enumNames: question.options.map((option) => option.label),
      };
    }
  }

  return { type: 'object', properties, required };
}

function supportsFormElicitation(
  caps: { elicitation?: Record<string, unknown> } | undefined,
): boolean {
  const elicitation = caps?.elicitation;
  if (!elicitation) return false;
  if (elicitation.form !== undefined) return true;
  // Spec: empty {} ≡ form-only
  return Object.keys(elicitation).length === 0 || elicitation.url === undefined;
}

async function elicitAnswers(
  server: McpServer,
  questions: Question[],
): Promise<Record<string, string | string[]> | null> {
  const caps = server.server.getClientCapabilities() as
    | { elicitation?: Record<string, unknown> }
    | undefined;

  if (!supportsFormElicitation(caps)) {
    log(
      `client elicitation unsupported: ${JSON.stringify(caps?.elicitation ?? null)}`,
    );
    return null;
  }

  const params = {
    mode: 'form' as const,
    message:
      questions.length === 1
        ? questions[0].prompt
        : `Answer ${questions.length} questions`,
    requestedSchema: schemaForQuestions(questions) as never,
  };

  try {
    const hasFormField = caps?.elicitation?.form !== undefined;
    const result = hasFormField
      ? await server.server.elicitInput(params)
      : await server.server.request(
          { method: 'elicitation/create', params },
          ElicitResultSchema,
        );

    if (result.action !== 'accept' || !result.content) {
      log(`elicit action=${result.action}`);
      return null;
    }

    const content = result.content as Record<string, unknown>;
    const answers: Record<string, string | string[]> = {};

    for (const question of questions) {
      const raw = content[question.id];
      if (question.allow_multiple && Array.isArray(raw)) {
        answers[question.id] = raw.map(String);
      } else if (typeof raw === 'string') {
        answers[question.id] = raw;
      } else {
        log(`missing answer for ${question.id}`);
        return null;
      }
    }

    return answers;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log(`elicit failed: ${message}`);
    return null;
  }
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
      'MCP form elicitation fallback for multiple-choice questions when host ' +
      'AskQuestion / AskUserQuestion are absent from the agent tool schema. ' +
      'Does NOT enable Cursor AskQuestion (host-injected, model-gated). ' +
      'Prefer host AskQuestion when present.',
    inputSchema,
  },
  async ({ questions }) => {
    const elicited = await elicitAnswers(server, questions);
    if (elicited !== null) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ answers: elicited }, null, 2),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: fallbackText(questions),
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
