// The three operator-owned labels on a capture — operator / task / robot —
// as rows of the inspection's definition list, editable in place.
//
// WHY they are editable at all: an imported bag is born without them. The
// recorder stamps those fields on a take it started itself; nothing stamps
// them on a directory that arrived from somewhere else, so an imported capture
// stayed unlabelled for good — and unlabelled also means invisible to every
// operator/task filter and to Datasets' grouping.
//
// The three save as ONE request on the same compare-and-swap path as the rest
// of the review (§4.1): they are one decision, by one person, at one moment.
// Three separate writes would be three chances for one of them to be refused
// on its own, leaving a capture half-relabelled with nothing saying which half.
//
// Empty renders as an invitation ("Set operator…"), not as an em dash. A dash
// reads as a value someone chose, and it hides the one fact this screen needs
// to convey about an imported bag: that the blank is yours to fill in.

import { useState } from 'react';
import { cn } from '../../components/ui';

export interface CaptureLabels {
  operator: string | null;
  task: string | null;
  robot: string | null;
}

export interface LabelEditing {
  /** Write the three. Resolves with the refusal in the operator's words, or
   *  null when it was actually saved — §12: only a save that happened may be
   *  reported as one. */
  save: (next: CaptureLabels) => Promise<string | null>;
  /** A save for this capture is already on the wire. */
  saving: boolean;
}

const FIELDS: { key: keyof CaptureLabels; label: string; placeholder: string }[] = [
  { key: 'operator', label: 'Operator', placeholder: 'Set operator…' },
  { key: 'task', label: 'Task', placeholder: 'Set task…' },
  { key: 'robot', label: 'Robot', placeholder: 'Set robot…' },
];

/** Trimmed, or null when nothing is left. Null is the contract's "clear it",
 *  which returns the field to whatever the manifest said; an empty string
 *  would store a label that is present and says nothing. */
function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function LabelRows({
  values,
  editing,
}: {
  values: CaptureLabels;
  editing: LabelEditing;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<keyof CaptureLabels, string>>({
    operator: '',
    task: '',
    robot: '',
  });
  const [error, setError] = useState<string | null>(null);

  const startEditing = () => {
    setDraft({
      operator: values.operator ?? '',
      task: values.task ?? '',
      robot: values.robot ?? '',
    });
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    const next: CaptureLabels = {
      operator: trimOrNull(draft.operator),
      task: trimOrNull(draft.task),
      robot: trimOrNull(draft.robot),
    };
    const refusal = await editing.save(next);
    if (refusal) {
      // Stay open, holding what they typed. The values are not on the server,
      // so closing would leave the screen showing the stored ones as though
      // the edit had never been attempted.
      setError(refusal);
      return;
    }
    setError(null);
    setOpen(false);
  };

  if (!open) {
    return (
      <>
        {FIELDS.map((field) => {
          const value = values[field.key];
          return (
            <RowFrame key={field.key} label={field.label}>
              <button
                type="button"
                data-testid={`label-edit-${field.key}`}
                onClick={startEditing}
                title="Edit operator, task and robot"
                className={cn(
                  'group inline-flex items-center gap-1.5 rounded-[5px] px-1 py-0.5 text-left hover:bg-gray-50',
                  value ? 'text-gray-700' : 'text-gray-500',
                )}
              >
                <span className={cn(!value && 'italic')}>
                  {value || field.placeholder}
                </span>
                <span aria-hidden="true" className="text-[11px] text-gray-500 group-hover:text-teal-600">
                  ✎
                </span>
              </button>
            </RowFrame>
          );
        })}
      </>
    );
  }

  return (
    <>
      {FIELDS.map((field) => (
        <RowFrame key={field.key} label={field.label}>
          <input
            type="text"
            data-testid={`label-input-${field.key}`}
            aria-label={field.label}
            value={draft[field.key]}
            placeholder={field.placeholder}
            disabled={editing.saving}
            onChange={(e) =>
              setDraft((cur) => ({ ...cur, [field.key]: e.target.value }))
            }
            className="w-full rounded-control border border-gray-200 px-2 py-1 text-[12.5px] text-gray-800 focus:border-teal-600 focus:outline-none disabled:bg-gray-50"
          />
        </RowFrame>
      ))}
      <dt />
      <dd className="flex flex-col gap-1.5 pt-1">
        {error && (
          <span
            role="alert"
            data-testid="label-error"
            className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900"
          >
            {error}
          </span>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            data-testid="label-save"
            onClick={() => void submit()}
            disabled={editing.saving}
            className="h-8 rounded-control bg-teal-700 px-3 text-[12px] font-bold text-white hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {editing.saving ? 'Saving…' : 'Save labels'}
          </button>
          <button
            type="button"
            data-testid="label-cancel"
            onClick={() => setOpen(false)}
            disabled={editing.saving}
            className="h-8 rounded-control border border-gray-200 bg-white px-3 text-[12px] font-semibold text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
        <span className="text-[11px] leading-snug text-gray-500">
          Clearing a field returns it to whatever the recording&apos;s own
          manifest said.
        </span>
      </dd>
    </>
  );
}

/** Same shape as the inspection's own Row, so these sit in that grid. */
function RowFrame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[11.5px] text-gray-500">{label}</dt>
      <dd className="text-[12.5px] text-gray-700">{children}</dd>
    </>
  );
}
