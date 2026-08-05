import { Ajv, type ErrorObject } from "ajv";
import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";

/** A substantive JSON Schema Draft 7 object used for an agent result. */
export type JsonSchema = Record<string, unknown>;

export const DEFAULT_RESULT_SCHEMA: JsonSchema = Object.freeze({
  type: "string",
});

const SUBSTANTIVE_SCHEMA_KEYS = new Set([
  "$ref",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "additionalItems",
  "items",
  "maxItems",
  "minItems",
  "uniqueItems",
  "contains",
  "maxProperties",
  "minProperties",
  "required",
  "properties",
  "patternProperties",
  "additionalProperties",
  "dependencies",
  "propertyNames",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
]);

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") {
    return value.constructor?.name ?? "object";
  }
  return typeof value;
}

function findNonJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): string | undefined {
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined;
    case "number":
      return Number.isFinite(value)
        ? undefined
        : `${path} contains the non-finite number ${String(value)}`;
    case "object": {
      if (value === null) return undefined;
      if (ancestors.has(value)) return `${path} contains a cycle`;
      const proto = Object.getPrototypeOf(value);
      if (
        !Array.isArray(value) &&
        proto !== Object.prototype &&
        proto !== null
      ) {
        return `${path} contains a non-JSON ${describeValue(value)}`;
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        return `${path} contains a symbol-keyed property`;
      }
      ancestors.add(value);
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          if (!Object.hasOwn(value, index)) {
            ancestors.delete(value);
            return `${path}[${index}] is an array hole`;
          }
          const error = findNonJsonValue(
            value[index],
            `${path}[${index}]`,
            ancestors,
          );
          if (error) {
            ancestors.delete(value);
            return error;
          }
        }
      } else {
        for (const [key, child] of Object.entries(value)) {
          const error = findNonJsonValue(child, `${path}.${key}`, ancestors);
          if (error) {
            ancestors.delete(value);
            return error;
          }
        }
      }
      ancestors.delete(value);
      return undefined;
    }
    default:
      return `${path} contains a non-JSON ${typeof value}`;
  }
}

/** Return a concrete explanation when a JavaScript value is not JSON data. */
export function jsonValueError(value: unknown): string | undefined {
  return findNonJsonValue(value, "$", new Set());
}

function schemaErrorText(errors: ErrorObject[] | null | undefined): string {
  const first = errors?.[0];
  if (!first) return "schema validation failed";
  const location = first.instancePath || "$";
  return `${location} ${first.message ?? "is invalid"}`;
}

/**
 * Validate the workflow-facing schema grammar and both runtime consumers.
 * Ajv supplies strict Draft 7 meta-validation; TypeBox compilation guarantees
 * that the schema can also be used by Pi's tool validator.
 */
export function validateJsonSchema(value: unknown): JsonSchema {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `must be a JSON Schema object, got ${describeValue(value)}`,
    );
  }
  const jsonError = jsonValueError(value);
  if (jsonError) throw new Error(`must contain only JSON data: ${jsonError}`);
  const schema = value as JsonSchema;
  if (Object.keys(schema).length === 0) {
    throw new Error("must not be empty");
  }
  if (!Object.keys(schema).some((key) => SUBSTANTIVE_SCHEMA_KEYS.has(key))) {
    throw new Error(
      "must contain at least one validation assertion, applicator, or $ref",
    );
  }

  const ajv = new Ajv({
    addUsedSchema: false,
    allErrors: true,
    allowUnionTypes: true,
    strict: true,
    validateSchema: true,
  });
  try {
    const valid = ajv.validateSchema(schema);
    if (!valid) throw new Error(schemaErrorText(ajv.errors));
    ajv.compile(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `is not a supported JSON Schema Draft 7 schema: ${message}`,
    );
  }
  try {
    Compile(schema as TSchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot be compiled by TypeBox: ${message}`);
  }
  return schema;
}

const validatorCache = new WeakMap<JsonSchema, Validator>();

export function effectiveResultSchema(schema?: JsonSchema): JsonSchema {
  return schema ?? DEFAULT_RESULT_SCHEMA;
}

export function compileResultSchema(schema?: JsonSchema): Validator {
  const effective = effectiveResultSchema(schema);
  const cached = validatorCache.get(effective);
  if (cached) return cached;
  const validator = Compile(effective as TSchema);
  validatorCache.set(effective, validator);
  return validator;
}

/** Return why a result violates the engine contract, or undefined if valid. */
export function resultValueError(
  value: unknown,
  schema?: JsonSchema,
): string | undefined {
  const jsonError = jsonValueError(value);
  if (jsonError) return jsonError;
  const validator = compileResultSchema(schema);
  if (validator.Check(value)) return undefined;
  const first = validator.Errors(value)[0];
  if (!first) return "does not match the declared result schema";
  return `${first.instancePath || "$"} ${first.message}`;
}

export interface AgentResultErrorEnvelope {
  error: { reason: string };
}

export interface AgentResultSuccessEnvelope {
  result: unknown;
}

export type AgentResultEnvelope =
  | AgentResultSuccessEnvelope
  | AgentResultErrorEnvelope;

/** Build the strict framework envelope around a workflow-owned payload. */
export function buildAgentResultEnvelopeSchema(
  payloadSchema: JsonSchema,
): TSchema {
  return {
    oneOf: [
      {
        type: "object",
        properties: { result: payloadSchema },
        required: ["result"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              reason: { type: "string", minLength: 1 },
            },
            required: ["reason"],
            additionalProperties: false,
          },
        },
        required: ["error"],
        additionalProperties: false,
      },
    ],
  } as TSchema;
}
