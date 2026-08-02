// Generic, backend-driven pipeline params form (OL-4.2). Renders one control
// per property of a JSON-Schema (from GET /api/v1/config -> schemas.pipeline_forms)
// so the orchestrator/dora_runner own the form shape and the UI never hardcodes
// a pipeline's params. Supports the pragmatic subset the backend emits:
// string / number / integer / boolean / enum / array-of-string.
//
// Special case: a field literally named `template` (fast_validation) is a catalog
// id the orchestrator resolves, so it renders as a SELECT of the known validation
// options rather than a free-text box (see routers/jobs.py, which resolves the
// id against the Config catalog before forwarding the job).

import type { JSONSchema } from '../../schema/jsonSchema';
import { schemaHasType } from '../../schema/jsonSchema';
import type { ValidationOption } from '../../api/types';

const FIELD_CLASS =
  'rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none';

interface PipelineFormProps {
  schema: JSONSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** Options for a field literally named `template` (catalog-resolved select). */
  templateOptions?: ValidationOption[];
  /** Context suggestions keyed by a property's `x-suggest` kind (e.g.
   *  `camera_topics` from the selected target capture). A string field whose
   *  schema carries `x-suggest` renders as a select of these instead of a
   *  free-text box; with no suggestions it falls back to text (honest). */
  suggestions?: Record<string, string[]>;
}

/** Parse a free-text "a, b c" string into a clean list of globs. */
function parseList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function fieldLabel(name: string, child: JSONSchema): string {
  return child.title ?? name;
}

function Field({
  name,
  child,
  required,
  value,
  onChange,
  templateOptions,
  suggestions,
}: {
  name: string;
  child: JSONSchema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  templateOptions?: ValidationOption[];
  suggestions?: Record<string, string[]>;
}) {
  const label = (
    <span className="text-[11px] font-medium text-gray-500">
      {fieldLabel(name, child)}
      {required && <span className="text-red-500"> *</span>}
    </span>
  );

  // template (fast_validation): catalog-id select, not a free text box.
  if (name === 'template' && templateOptions) {
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <select
          aria-label={name}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          disabled={templateOptions.length === 0}
          className={FIELD_CLASS}
        >
          {templateOptions.length === 0 ? (
            <option value="">No templates registered</option>
          ) : (
            templateOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version}) · {t.required_topics.length} topics
              </option>
            ))
          )}
        </select>
      </label>
    );
  }

  // x-suggest (string) -> select of context suggestions (e.g. the target run's
  // camera topics for video_check's `topic`) — no hand-typing full topic paths.
  // The current value stays selectable even if it isn't in the list (a preset
  // or an earlier target could have set it), and with no suggestions at all the
  // field falls through to the plain text input below.
  const suggestKind = child['x-suggest'];
  const suggested = suggestKind ? (suggestions?.[suggestKind] ?? []) : [];
  if (suggestKind && schemaHasType(child, 'string') && suggested.length > 0) {
    const current = String(value ?? '');
    const options =
      current && !suggested.includes(current) ? [current, ...suggested] : suggested;
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <select
          aria-label={name}
          value={current}
          onChange={(e) => onChange(e.target.value)}
          className={FIELD_CLASS}
        >
          {!current && <option value="">Select…</option>}
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // enum -> select.
  if (child.enum && child.enum.length > 0) {
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <select
          aria-label={name}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={FIELD_CLASS}
        >
          {child.enum.map((opt) => (
            <option key={String(opt)} value={String(opt)}>
              {String(opt)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  // boolean -> checkbox.
  if (schemaHasType(child, 'boolean')) {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          aria-label={name}
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 rounded border-gray-300 text-teal-600 focus:ring-teal-500"
        />
        {label}
      </label>
    );
  }

  // array (of strings) -> comma/space separated text box.
  if (schemaHasType(child, 'array')) {
    const list = Array.isArray(value) ? (value as unknown[]).map(String) : [];
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <input
          type="text"
          aria-label={name}
          value={list.join(', ')}
          placeholder={child.description ?? 'comma or space separated'}
          onChange={(e) => onChange(parseList(e.target.value))}
          className={FIELD_CLASS}
        />
      </label>
    );
  }

  // number / integer -> number input (empty -> null so it round-trips).
  if (schemaHasType(child, 'number') || schemaHasType(child, 'integer')) {
    return (
      <label className="flex flex-col gap-1 text-sm">
        {label}
        <input
          type="number"
          aria-label={name}
          value={value === null || value === undefined ? '' : String(value)}
          min={child.minimum}
          max={child.maximum}
          onChange={(e) =>
            onChange(e.target.value === '' ? null : Number(e.target.value))
          }
          className={FIELD_CLASS}
        />
      </label>
    );
  }

  // default: string text input.
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <input
        type="text"
        aria-label={name}
        value={String(value ?? '')}
        placeholder={child.description}
        onChange={(e) => onChange(e.target.value)}
        className={FIELD_CLASS}
      />
    </label>
  );
}

/** Render a form for a pipeline's params JSON-Schema. Controlled by `value`. */
export function PipelineForm({
  schema,
  value,
  onChange,
  templateOptions,
  suggestions,
}: PipelineFormProps) {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return <p className="text-[11px] text-gray-400">No parameters for this pipeline.</p>;
  }
  return (
    <>
      {entries.map(([key, child]) => (
        <Field
          key={key}
          name={key}
          child={child}
          required={required.has(key)}
          value={value[key]}
          onChange={(v) => set(key, v)}
          templateOptions={key === 'template' ? templateOptions : undefined}
          suggestions={suggestions}
        />
      ))}
    </>
  );
}
