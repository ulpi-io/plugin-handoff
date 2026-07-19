#!/usr/bin/env node
// Handoff is a strict machine driver. Slash commands prepare a versioned request and invoke this
// same entry point; there is no alternate provider/verb interface or weaker execution path.
import { fileURLToPath } from 'node:url';

import {
  executeMachineRun,
  machineCapabilities,
  machineFailure,
  parseMachineCli,
} from './lib/machine.mjs';

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

function emitMachine(machine) {
  const diagnostics = [
    machine.result.diagnostics.message,
    machine.result.diagnostics.providerStderr,
  ].filter((value) => typeof value === 'string' && value.trim());
  if (diagnostics.length) process.stderr.write(`${diagnostics.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(machine.result)}\n`);
  process.exitCode = machine.exitCode;
}

if (isMain) {
  let machine;
  try {
    const options = parseMachineCli(process.argv.slice(2));
    if (options.command === 'capabilities') {
      process.stdout.write(`${JSON.stringify(machineCapabilities())}\n`);
      process.exitCode = 0;
    } else {
      machine = await executeMachineRun(options);
      emitMachine(machine);
    }
  } catch (error) {
    machine = machineFailure(error);
    emitMachine(machine);
  }
}
