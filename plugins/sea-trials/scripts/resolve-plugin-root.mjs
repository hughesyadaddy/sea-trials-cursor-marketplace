#!/usr/bin/env node
/**
 * Print the Sea Trials Cursor plugin root (parent of scripts/).
 * Shipped at plugins/sea-trials/scripts/resolve-plugin-root.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
console.log(path.resolve(scriptDir, '..'));
