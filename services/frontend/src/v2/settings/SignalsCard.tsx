// Settings > Data quality > Signals — form-first editor for the ACTIVE robot's
// Review Signals defaults (GET/PUT /api/v1/config/signals). Display-only config,
// so it applies immediately (the Review consumption hook re-fetches it). The form
// edits the common facts (hidden field patterns, the default topic, per-msg_type
// field lists, the fallback count); an Advanced disclosure edits the raw YAML for
// anything the form doesn't surface. Mirrors RecordingSection's form/Advanced
// split and its 422-details validation UX. Save validates server-side.

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet } from '../../api/client';
import { Badge, Button, Card, cn } from '../../components/ui';
import { ErrorMessage } from '../../components/ErrorMessage';
import {
  SIGNALS_CONFIG_KEY,
  formatValidationDetails,
  putSignalsConfig,
  type AspectPutBody,
  type SignalsConfig,
  type SignalsPayload,
} from './configAspects';

interface FormState {
  hiddenPatterns: string[];
  defaultTopic: string;
  // `fields` kept as a comma/newline string while editing; split on save.
  defaults: { msgType: string; fields: string }[];
  fallbackFields: string;
}

/** Split a comma/newline-separated field list into trimmed, non-empty paths. */
function splitList(s: string): string[] {
  return s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function toForm(cfg: SignalsConfig | null): FormState {
  return {
    hiddenPatterns: cfg?.hidden_field_patterns ?? [],
    defaultTopic: cfg?.default_topic ?? '',
    defaults: (cfg?.defaults ?? []).map((d) => ({
      msgType: d.msg_type,
      fields: (d.fields ?? []).join(', '),
    })),
    fallbackFields: String(cfg?.fallback_fields ?? 4),
  };
}

function toConfig(f: FormState): Record<string, unknown> {
  return {
    hidden_field_patterns: f.hiddenPatterns.map((s) => s.trim()).filter(Boolean),
    default_topic: f.defaultTopic.trim() || null,
    defaults: f.defaults
      .map((d) => ({ msg_type: d.msgType.trim(), fields: splitList(d.fields) }))
      .filter((d) => d.msg_type),
    // NaN (empty/garbage) -> 0, which the server accepts (fallback_fields >= 0).
    fallback_fields: Math.max(0, Number.parseInt(f.fallbackFields, 10) || 0),
  };
}

const INPUT =
  'rounded-control border border-gray-200 px-2 py-1 text-[12.5px] focus:border-teal-500 focus:outline-none';

export function SignalsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SIGNALS_CONFIG_KEY,
    queryFn: ({ signal }) => apiGet<SignalsPayload>('/config/signals', { signal }),
  });

  const [form, setForm] = useState<FormState>(() => toForm(null));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [rawText, setRawText] = useState('');
  const [saved, setSaved] = useState(false);

  // Reseed the form + raw buffer from the fetched payload (and after a save, when
  // setQueryData swaps in the canonical server copy).
  useEffect(() => {
    if (query.data) {
      setForm(toForm(query.data.config));
      setRawText(query.data.raw ?? '');
      setSaved(false);
    }
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (body: AspectPutBody) => putSignalsConfig(body),
    onSuccess: (data) => {
      setSaved(true);
      queryClient.setQueryData(SIGNALS_CONFIG_KEY, data);
    },
  });

  const path = query.data?.path;
  const details = formatValidationDetails(mutation.error);

  const saveForm = () => {
    setSaved(false);
    mutation.mutate({ config: toConfig(form) });
  };
  const saveRaw = () => {
    setSaved(false);
    mutation.mutate({ raw: rawText });
  };

  const setDefault = (i: number, patch: Partial<{ msgType: string; fields: string }>) =>
    setForm((f) => ({
      ...f,
      defaults: f.defaults.map((d, j) => (j === i ? { ...d, ...patch } : d)),
    }));

  return (
    <Card className="flex min-w-0 flex-col gap-4 overflow-auto p-[18px]" data-testid="settings-signals">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
          Signals defaults
        </span>
        <Badge tone="green" dot>
          applies immediately
        </Badge>
        <span className="text-[11px] text-gray-400">Review · display-only</span>
      </div>

      {query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.isPending ? (
        <p className="text-sm text-gray-500">Loading signals config…</p>
      ) : (
        <>
          <p className="text-[11.5px] leading-relaxed text-gray-500">
            Which decoded numeric fields the Review › Signals section selects by default.
            Fields absent from a given recording are ignored at render time.
          </p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-gray-600">Default topic</span>
              <input
                aria-label="signals default topic"
                className={cn(INPUT, 'font-mono')}
                value={form.defaultTopic}
                placeholder="/hsrb/joint_states"
                onChange={(e) => setForm((f) => ({ ...f, defaultTopic: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-gray-600">
                Fallback fields (no rule matched)
              </span>
              <input
                aria-label="signals fallback fields"
                type="number"
                min={0}
                className={cn(INPUT, 'font-mono w-24')}
                value={form.fallbackFields}
                onChange={(e) => setForm((f) => ({ ...f, fallbackFields: e.target.value }))}
              />
            </label>
          </div>

          {/* Hidden field patterns (fnmatch on field paths). */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-gray-600">
              Hidden field patterns (fnmatch)
            </span>
            <div className="flex flex-col gap-1.5" data-testid="signals-hidden-patterns">
              {form.hiddenPatterns.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    aria-label={`hidden pattern ${i}`}
                    className={cn(INPUT, 'font-mono flex-1')}
                    value={p}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        hiddenPatterns: f.hiddenPatterns.map((x, j) => (j === i ? e.target.value : x)),
                      }))
                    }
                  />
                  <button
                    type="button"
                    aria-label={`remove hidden pattern ${i}`}
                    className="rounded-control px-2 py-1 text-[12px] text-gray-400 hover:bg-gray-50 hover:text-red-600"
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        hiddenPatterns: f.hiddenPatterns.filter((_, j) => j !== i),
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              data-testid="signals-add-pattern"
              className="self-start rounded-control border border-gray-200 px-2 py-1 text-[11.5px] text-gray-600 hover:bg-gray-50"
              onClick={() => setForm((f) => ({ ...f, hiddenPatterns: [...f.hiddenPatterns, ''] }))}
            >
              + Add pattern
            </button>
          </div>

          {/* Per-msg_type default field lists. */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold text-gray-600">
              Default fields per message type
            </span>
            <div className="flex flex-col gap-2" data-testid="signals-defaults">
              {form.defaults.map((d, i) => (
                <div key={i} className="flex flex-col gap-1 rounded-control border border-gray-100 p-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      aria-label={`rule msg_type ${i}`}
                      className={cn(INPUT, 'font-mono flex-1')}
                      placeholder="sensor_msgs/msg/JointState"
                      value={d.msgType}
                      onChange={(e) => setDefault(i, { msgType: e.target.value })}
                    />
                    <button
                      type="button"
                      aria-label={`remove rule ${i}`}
                      className="rounded-control px-2 py-1 text-[12px] text-gray-400 hover:bg-gray-50 hover:text-red-600"
                      onClick={() =>
                        setForm((f) => ({ ...f, defaults: f.defaults.filter((_, j) => j !== i) }))
                      }
                    >
                      ×
                    </button>
                  </div>
                  <input
                    aria-label={`rule fields ${i}`}
                    className={cn(INPUT, 'font-mono')}
                    placeholder="position[0], position[1]"
                    value={d.fields}
                    onChange={(e) => setDefault(i, { fields: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <button
              type="button"
              data-testid="signals-add-rule"
              className="self-start rounded-control border border-gray-200 px-2 py-1 text-[11.5px] text-gray-600 hover:bg-gray-50"
              onClick={() =>
                setForm((f) => ({ ...f, defaults: [...f.defaults, { msgType: '', fields: '' }] }))
              }
            >
              + Add rule
            </button>
          </div>

          {mutation.isError && (
            <div>
              <ErrorMessage error={mutation.error} />
              {details.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-red-700" data-testid="signals-errors">
                  {details.map((d, i) => (
                    <li key={i} className="font-mono">
                      {d}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {saved && !mutation.isPending && (
            <p data-testid="signals-saved" className="text-[12.5px] font-medium text-teal-700">
              Saved — applies to the next Review Signals view.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              data-testid="signals-save"
              onClick={saveForm}
              disabled={mutation.isPending}
              className="px-4 py-1.5 text-sm disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
            <span className="text-[11px] text-gray-400">The server validates on save.</span>
          </div>

          {/* Advanced: raw YAML (spec §12 — raw is Advanced). */}
          <div className="rounded-control border border-gray-200">
            <button
              type="button"
              data-testid="signals-advanced-toggle"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((o) => !o)}
              className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-[12.5px] font-semibold text-gray-700 hover:bg-gray-50"
            >
              <span className={cn('text-gray-400 transition-transform', advancedOpen && 'rotate-90')}>
                ▸
              </span>
              Advanced — edit raw YAML
              {path && <span className="font-mono text-[11px] font-normal text-gray-400">{path}</span>}
            </button>
            {advancedOpen && (
              <div className="flex flex-col gap-2 border-t border-gray-100 p-3.5" data-testid="signals-advanced">
                <textarea
                  aria-label="signals config yaml"
                  className="h-56 w-full rounded-control border border-gray-200 p-2 font-mono text-xs focus:border-teal-500 focus:outline-none"
                  spellCheck={false}
                  value={rawText}
                  placeholder="hidden_field_patterns: [&quot;header.*&quot;]&#10;fallback_fields: 4"
                  onChange={(e) => setRawText(e.target.value)}
                />
                <Button
                  type="button"
                  data-testid="signals-save-raw"
                  onClick={saveRaw}
                  disabled={mutation.isPending}
                  className="self-start px-4 py-1.5 text-sm disabled:opacity-50"
                >
                  {mutation.isPending ? 'Saving…' : 'Save YAML'}
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
