// Minimal JSON Schema (draft 2020-12) typing and helpers, just enough to drive
// backend-provided forms (record_start, pipeline_forms). We intentionally
// support a pragmatic subset: object/array/string/number/integer/boolean,
// enum, const, oneOf, default and required. Unknown constructs degrade to a
// plain text/JSON field rather than failing.

export type JSONSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

export interface JSONSchema {
  $schema?: string;
  type?: JSONSchemaType | JSONSchemaType[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  required?: string[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  minimum?: number;
  maximum?: number;
}

/** True if the schema's `type` includes the given primitive (handles unions). */
export function schemaHasType(schema: JSONSchema, t: JSONSchemaType): boolean {
  if (Array.isArray(schema.type)) return schema.type.includes(t);
  return schema.type === t;
}

/** True when `null` is an allowed type for this schema. */
export function schemaIsNullable(schema: JSONSchema): boolean {
  return schemaHasType(schema, 'null');
}

/**
 * Build an initial form value for a schema, honoring `default` and required
 * object properties. Used to seed forms so they round-trip cleanly.
 */
export function initialValueFor(schema: JSONSchema): unknown {
  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  if (schemaHasType(schema, 'object') && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties)) {
      const isRequired = schema.required?.includes(key) ?? false;
      if (isRequired || child.default !== undefined) {
        out[key] = initialValueFor(child);
      }
    }
    return out;
  }
  if (schemaHasType(schema, 'array')) return [];
  if (schemaHasType(schema, 'boolean')) return false;
  if (schemaHasType(schema, 'integer') || schemaHasType(schema, 'number')) {
    return schemaIsNullable(schema) ? null : 0;
  }
  if (schemaHasType(schema, 'string')) return '';
  if (schemaIsNullable(schema)) return null;
  return undefined;
}
