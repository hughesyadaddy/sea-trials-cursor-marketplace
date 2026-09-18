#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
console.log(path.resolve(scriptDir, '..'));
