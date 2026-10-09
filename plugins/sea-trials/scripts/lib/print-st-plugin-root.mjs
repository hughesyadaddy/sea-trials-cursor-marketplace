#!/usr/bin/env node
/**
 * Print absolute Sea Trials plugin root (stdout, no trailing noise).
 * Uses resolveStPluginRoot() — newest Team Marketplace cache wins.
 */
import { resolveStPluginRoot } from './resolve-st-plugin-root.mjs';

try {
  process.stdout.write(`${resolveStPluginRoot()}\n`);
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}
