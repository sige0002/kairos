// A pragmatic, backend-driven form renderer for the JSON Schema subset we use
// (record_start, pipeline_forms). It is intentionally small: object properties
// become fields; enums become selects; oneOf with a `{const:"all"}` branch (as
// in record_start.topics) becomes a toggle between "all" and the alternative.
// Anything it doesn't understand falls back to a JSON textarea so the form is
// never a dead end.

import { useMemo, useState } from 'react';
import {
  type JSONSchema,
  initialValueFor,
  schemaHasType,
  schemaIsNullable,
} from '../schema/jsonSchema';

export interface SchemaFormProps {
  schema: JSONSchema;
  /** Seed values merged over schema defaults (e.g. config.defaults). */
  initialValue?: Record<string, unknown>;
  onSubmit: (value: Record<string, unknown>) => void;
  submitLabel?: string;
  disabled?: boolean;
}

type Setter = (value: unknown) => void;

function labelFor(key: string, schema: JSONSchema): string {
  return schema.title ?? key;
}

/** A oneOf where one branch is the literal "all" (record_start.topics shape). */
function isAllOrListSchema(schema: JSONSchema): boolean {
  if (!schema.oneOf) return false;
  return schema.oneOf.some((b) => b.const === 'all');
}

function Field({
  name,
  schema,
  value,
  onChange,
  required,
  disabled,
}: {
  name: string;
  schema: JSONSchema;
  value: unknown;
  onChange: Setter;
  required: boolean;
  disabled?: boolean;
}) {
  const label = labelFor(name, schema);
  const id = `field-${name}`;

  // enum -> select
  if (schema.enum && schema.enum.length > 0) {
    return (
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          {label}
          {required ? ' *' : ''}
        </span>
        <select
          id={id}
          className="rounded border px-2 py-1"
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {schema.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // boolean -> checkbox
  if (schemaHasType(schema, 'boolean')) {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="font-medium">{label}</span>
      </label>
    );
  }

  // number / integer
  if (schemaHasType(schema, 'integer') || schemaHasType(schema, 'number')) {
    const nullable = schemaIsNullable(schema);
    return (
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          {label}
          {required ? ' *' : ''}
        </span>
        <input
          id={id}
          type="number"
          className="rounded border px-2 py-1"
          value={value === null || value === undefined ? '' : String(value)}
          min={schema.minimum}
          max={schema.maximum}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') {
              onChange(nullable ? null : undefined);
              return;
            }
            const num = schemaHasType(schema, 'integer')
              ? parseInt(raw, 10)
              : Number(raw);
            onChange(Number.isNaN(num) ? (nullable ? null : undefined) : num);
          }}
        />
      </label>
    );
  }

  // array of strings -> comma/newline separated textarea
  if (schemaHasType(schema, 'array')) {
    const arr = Array.isArray(value) ? (value as unknown[]) : [];
    return (
      <label htmlFor={id} className="flex flex-col gap-1 text-sm">
        <span className="font-medium">
          {label}
          {required ? ' *' : ''}
        </span>
        <textarea
          id={id}
          className="rounded border px-2 py-1 font-mono"
          rows={3}
          placeholder="one per line"
          value={arr.map(String).join('\n')}
          disabled={disabled}
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/[\n,]/)
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
        />
      </label>
    );
  }

  // object (nullable optional, e.g. split) -> nested fields with enable toggle
  if (schemaHasType(schema, 'object') && schema.properties) {
    const enabled = value !== null && value !== undefined;
    const obj = (enabled ? (value as Record<string, unknown>) : {}) ?? {};
    return (
      <fieldset className="flex flex-col gap-2 rounded border p-2 text-sm">
        <legend className="flex items-center gap-2 font-medium">
          {schemaIsNullable(schema) && (
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled}
              onChange={(e) =>
                onChange(e.target.checked ? initialValueFor(schema) : null)
              }
              aria-label={`enable ${label}`}
            />
          )}
          {label}
        </legend>
        {enabled &&
          Object.entries(schema.properties).map(([childName, childSchema]) => (
            <Field
              key={childName}
              name={childName}
              schema={childSchema}
              value={obj[childName]}
              required={schema.required?.includes(childName) ?? false}
              disabled={disabled}
              onChange={(v) => onChange({ ...obj, [childName]: v })}
            />
          ))}
      </fieldset>
    );
  }

  // default: string input
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">
        {label}
        {required ? ' *' : ''}
      </span>
      <input
        id={id}
        type="text"
        className="rounded border px-2 py-1"
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * The "all" vs explicit-list selector used by record_start.topics. Rendered as
 * a radio toggle; when "list" is selected, a textarea provides the array.
 */
function AllOrListField({
  name,
  schema,
  value,
  onChange,
  required,
  disabled,
}: {
  name: string;
  schema: JSONSchema;
  value: unknown;
  onChange: Setter;
  required: boolean;
  disabled?: boolean;
}) {
  const isAll = value === 'all';
  const listSchema = schema.oneOf?.find((b) => b.const !== 'all') ?? {
    type: 'array',
    items: { type: 'string' },
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded border p-2 text-sm">
      <legend className="font-medium">
        {labelFor(name, schema)}
        {required ? ' *' : ''}
      </legend>
      <div className="flex gap-4">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`${name}-mode`}
            checked={isAll}
            disabled={disabled}
            onChange={() => onChange('all')}
          />
          all topics
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`${name}-mode`}
            checked={!isAll}
            disabled={disabled}
            onChange={() => onChange(Array.isArray(value) ? value : [])}
          />
          select topics
        </label>
      </div>
      {!isAll && (
        <Field
          name={name}
          schema={listSchema}
          value={value}
          required={required}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </fieldset>
  );
}

export function SchemaForm({
  schema,
  initialValue,
  onSubmit,
  submitLabel = 'Submit',
  disabled,
}: SchemaFormProps) {
  const seed = useMemo(() => {
    const base = initialValueFor(schema);
    const baseObj =
      base && typeof base === 'object' ? (base as Record<string, unknown>) : {};
    return { ...baseObj, ...(initialValue ?? {}) };
  }, [schema, initialValue]);

  const [value, setValue] = useState<Record<string, unknown>>(seed);

  // If the schema isn't an object with properties, render a raw JSON editor.
  if (!schemaHasType(schema, 'object') || !schema.properties) {
    return (
      <RawJsonForm onSubmit={onSubmit} submitLabel={submitLabel} disabled={disabled} />
    );
  }

  const properties = schema.properties;
  const required = schema.required ?? [];

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      {Object.entries(properties).map(([name, childSchema]) =>
        isAllOrListSchema(childSchema) ? (
          <AllOrListField
            key={name}
            name={name}
            schema={childSchema}
            value={value[name]}
            required={required.includes(name)}
            disabled={disabled}
            onChange={(v) => setValue((cur) => ({ ...cur, [name]: v }))}
          />
        ) : (
          <Field
            key={name}
            name={name}
            schema={childSchema}
            value={value[name]}
            required={required.includes(name)}
            disabled={disabled}
            onChange={(v) => setValue((cur) => ({ ...cur, [name]: v }))}
          />
        ),
      )}
      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </form>
  );
}

/** Fallback raw-JSON editor for schemas we can't render structurally. */
function RawJsonForm({
  onSubmit,
  submitLabel,
  disabled,
}: {
  onSubmit: (value: Record<string, unknown>) => void;
  submitLabel: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          setError(null);
          onSubmit(parsed);
        } catch {
          setError('Invalid JSON');
        }
      }}
    >
      <textarea
        className="rounded border px-2 py-1 font-mono text-sm"
        rows={6}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        aria-label="request body JSON"
      />
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </form>
  );
}
