/**
 * Wire contract between the parent spawn engine and the static result-tool
 * extension loaded into every delegated `pi --mode rpc` child.
 *
 * The parent configures the child by invoking an extension command over the
 * existing RPC prompt channel:
 *
 *   /__pi_agents_configure_result_v1 {"version":1,...}
 *
 * Pi passes everything after the first ASCII space to the command handler
 * byte-for-byte, so the payload is plain JSON. Configuration failures throw
 * inside the handler; Pi surfaces them as `extension_error` events on the
 * RPC stream, which the parent treats as a fatal protocol failure.
 */

import type { JsonSchema } from "../model/json-schema.js";

export const RESULT_TOOL_NAME = "pi_agents_submit_result";

export const CONFIGURE_RESULT_COMMAND = "__pi_agents_configure_result_v1";

export interface ResultToolConfiguration {
  version: 1;
  /**
   * The effective result schema after workflow preflight. The default string
   * schema has already been applied; the child does not re-validate it.
   */
  resultSchema: JsonSchema;
  /**
   * Names a file whose existence defers result submission: while a
   * supervising user is attached, the agent may not terminate.
   */
  holdFile: string;
}

/** The full RPC prompt message that configures the child's result tool. */
export function encodeConfigureResultPrompt(
  config: ResultToolConfiguration,
): string {
  return `/${CONFIGURE_RESULT_COMMAND} ${JSON.stringify(config)}`;
}

export function decodeResultToolConfiguration(
  args: string,
): ResultToolConfiguration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse result-tool configuration: ${message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Result-tool configuration must be a JSON object");
  }
  const config = parsed as ResultToolConfiguration;
  // Protocol dispatch, not another schema-validation pass.
  if (config.version !== 1) {
    throw new Error(
      `Unsupported result-tool configuration version: ${String(config.version)}`,
    );
  }
  if (typeof config.resultSchema !== "object" || config.resultSchema === null) {
    throw new Error("Result-tool configuration must carry a result schema");
  }
  if (typeof config.holdFile !== "string" || !config.holdFile) {
    throw new Error("Result-tool configuration must name a hold file");
  }
  return config;
}
