#!/usr/bin/env node
/**
 * Minimal newline-delimited MCP setup server for missing subscription auth.
 *
 * Stdout contains JSON-RPC only. Notifications are ignored, supported requests
 * return setup information, and the server exits naturally when stdin ends.
 */
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SETUP_MESSAGE = 'Install Claude Code, run claude auth login with your '
  + 'own Pro/Max subscription, run st-subscriptions-preflight, '
  + 'then reload Cursor.';

/**
 * Serve setup instructions without requiring a subscription login.
 *
 * @param {string} message
 * @param {NodeJS.ReadableStream} [input]
 * @param {NodeJS.WritableStream} [output]
 * @returns {readline.Interface}
 */
export function serveSetupStub(
  message,
  input = process.stdin,
  output = process.stdout,
) {
  const lines = readline.createInterface({ input });
  lines.on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }) + '\n');
      return;
    }
    if (request.id === undefined) {
      return;
    }
    let result;
    let error;
    switch (request.method) {
      case 'initialize':
        result = {
          protocolVersion: request.params?.protocolVersion
            || DEFAULT_PROTOCOL_VERSION,
          serverInfo: {
            name: 'sea-trials-subscription-setup',
            version: '1.0.0',
          },
          capabilities: { tools: {} },
        };
        break;
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = {
          tools: [{
            name: 'subscription_setup_status',
            description: 'Show subscription setup steps.',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          }],
        };
        break;
      case 'tools/call':
        if (request.params?.name === 'subscription_setup_status') {
          result = { content: [{ type: 'text', text: message }] };
        } else {
          error = { code: -32602, message: 'Unknown tool' };
        }
        break;
      default:
        error = { code: -32601, message: 'Method not found' };
    }
    output.write(JSON.stringify({
      jsonrpc: '2.0',
      id: request.id,
      ...(error ? { error } : { result }),
    }) + '\n');
  });
  return lines;
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href
) {
  serveSetupStub(SETUP_MESSAGE);
}
