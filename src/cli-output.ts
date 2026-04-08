import type { Command } from 'commander';
import { CommanderError } from 'commander';

import { toAiocsError, AIOCS_ERROR_CODES } from './errors.js';

export type CliSuccessEnvelope<TData> = {
  ok: true;
  command: string;
  data: TData;
};

export type CliErrorEnvelope = {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type CliEnvelope<TData> = CliSuccessEnvelope<TData> | CliErrorEnvelope;

export type HumanOutput = string | string[] | undefined;

type EmitSuccessInput<TData> = {
  json: boolean;
  commandName: string;
  data: TData;
  human?: HumanOutput;
};

type EmitErrorInput = {
  json: boolean;
  commandName: string;
  error: unknown;
};

function toLines(output: HumanOutput): string[] {
  if (!output) {
    return [];
  }

  return Array.isArray(output) ? output : [output];
}

function serializeEnvelope<TData>(envelope: CliEnvelope<TData>): string {
  return JSON.stringify(envelope);
}

export function argvWantsJson(argv: string[]): boolean {
  return argv.includes('--json');
}

export function commandWantsJson(command: Command): boolean {
  return Boolean(command.optsWithGlobals().json);
}

export function emitSuccess<TData>(input: EmitSuccessInput<TData>): void {
  if (input.json) {
    console.log(serializeEnvelope({
      ok: true,
      command: input.commandName,
      data: input.data,
    }));
    return;
  }

  for (const line of toLines(input.human)) {
    console.log(line);
  }
}

function normalizeError(error: unknown): CliErrorEnvelope['error'] {
  if (error instanceof CommanderError) {
    return {
      code: AIOCS_ERROR_CODES.invalidArgument,
      message: error.message,
    };
  }

  const normalized = toAiocsError(error);
  return {
    code: normalized.code,
    message: normalized.message,
    ...(typeof normalized.details !== 'undefined' ? { details: normalized.details } : {}),
  };
}

export function emitError(input: EmitErrorInput): void {
  const normalized = normalizeError(input.error);

  if (input.json) {
    console.log(serializeEnvelope({
      ok: false,
      command: input.commandName,
      error: normalized,
    }));
    return;
  }

  console.error(normalized.message);
}

export function inferRequestedCommand(argv: string[]): string {
  const tokens = argv.filter((token) => token !== '--json' && token !== '--help' && token !== '-h');
  const first = tokens[0];
  const second = tokens[1];

  if (!first) {
    return 'cli';
  }

  if (['source', 'snapshot', 'page', 'project', 'refresh', 'verify', 'backup', 'learning'].includes(first) && second && !second.startsWith('-')) {
    return `${first}.${second}`;
  }

  return first;
}
