// Review > Import bags — bring recordings made outside kairos into the catalog.
//
// The shape is "look before you copy": the operator names a FOLDER (a server
// path — these are multi-GB directories, there is no browser upload), the
// server scans it shallowly, and this dialog shows every bag directory it
// found with what will happen to each one BEFORE a byte moves. A folder of
// forty recordings where the twelfth has no metadata.yaml should say so on one
// screen, not fail after the twelfth copy.
//
// The run itself is sequential and NEVER aborts on a failure: each bag is its
// own import, a failed one is recorded with its reason and the rest continue.
// A bulk operation that stops at the first bad directory would leave the
// operator hand-importing the remainder.

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../../api/client';
import { useOperators } from '../plans';
import { readCaptureError } from '../captures/errors';
import { Button, Modal, cn } from '../../components/ui';
import { formatBytes } from './format';

/** The label rules the import contract states. Mirrored, not re-invented: the
 *  server remains the authority and refuses anything else it dislikes — this
 *  only spares the operator a round trip for the two documented cases. */
const LABEL_MAX_BYTES = 255;
function labelProblem(labels: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(labels)) {
    if (value.includes('/')) return `The ${key} cannot contain a “/”.`;
    if (new TextEncoder().encode(value).length > LABEL_MAX_BYTES) {
      return `The ${key} is longer than ${LABEL_MAX_BYTES} bytes.`;
    }
  }
  return null;
}

const TAG_FIELDS = [
  { key: 'operator', label: 'operator' },
  { key: 'task', label: 'task' },
  { key: 'robot', label: 'robot' },
] as const;

/** One candidate directory from `GET /api/v1/imports/scan`. */
interface ScannedBag {
  path: string;
  name: string;
  importable: boolean;
  /** Why it cannot come in (already imported, no metadata.yaml, …). */
  reason?: string;
  remedy?: string;
  capture_id?: string;
  bytes?: number;
  topics?: number;
  message_count?: number;
  duration_s?: number;
}

interface ScanResult {
  path: string;
  bags: ScannedBag[];
  importable: number;
  /** The scan hit its breadth cap — the list is INCOMPLETE. (Depth is not a
   *  truncation: one level is the stated policy.) */
  truncated?: boolean;
  max_depth?: number;
  /** Subfolders that are not bags but hold bags one level further down. The
   *  list stays one level deep; this is the way down. */
  nested?: { path: string; name: string; bags: number }[];
}

type RowState =
  | { phase: 'idle' }
  | { phase: 'importing' } // POST in flight
  | {
      // Accepted (202) and copying server-side. The 202 is only "queued" —
      // with two copy slots the tail of a bulk run finishes long after the
      // POSTs — so the row watches GET /imports/{id} to its real end (S3-2).
      phase: 'copying';
      importId: string;
      captureId?: string;
      done: number;
      total: number | null;
    }
  | { phase: 'done'; captureId?: string }
  | { phase: 'failed'; error: string };

/** One import's server-side record (`GET /imports/{id}`). */
interface ImportRecord {
  import_id: string;
  capture_id?: string;
  state: 'running' | 'succeeded' | 'failed';
  bytes_total?: number | null;
  bytes_copied?: number | null;
  error?: { code: string; message: string } | null;
}

// Test seam: the watch is a real wall-clock poll.
let importWatchMs: number | null = null;
export function __setImportWatchMs(ms: number): void {
  importWatchMs = ms;
}
export function __resetImportWatchMs(): void {
  importWatchMs = null;
}
const IMPORT_WATCH_MS = 1500;

function summarize(bag: ScannedBag): string {
  const parts: string[] = [];
  if (bag.topics != null) parts.push(`${bag.topics} topics`);
  if (bag.message_count != null) parts.push(`${bag.message_count.toLocaleString()} msgs`);
  if (bag.duration_s != null) parts.push(`${Math.round(bag.duration_s)} s`);
  if (bag.bytes != null) parts.push(formatBytes(bag.bytes));
  return parts.join(' · ');
}

export function ImportBagsDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a run that imported at least one bag, so Review refetches. */
  onImported: () => void;
}) {
  const [path, setPath] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  /** The path the shown results describe — NOT the input box, which the
   *  operator may have edited since. Importing what a stale list says while
   *  the box shows another folder is the confusion this separates. */
  const [scannedPath, setScannedPath] = useState('');
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [move, setMove] = useState(false);
  // Labels stamped on EVERY bag of this import. A bag recorded outside kairos
  // has no operator or task of its own — the recorder writes those on a take it
  // started — so without this the whole import lands unlabelled and invisible
  // to every operator/task filter. They go into the manifest the capture is
  // born with; this is not the §4.3 review override.
  const [tags, setTags] = useState({ operator: '', task: '', robot: '' });
  // A refusal about the LABELS is not a per-bag failure: the server takes the
  // whole request or none of it, so it belongs beside the inputs that caused
  // it and must not be scattered across the rows as N identical row errors.
  const [tagError, setTagError] = useState<string | null>(null);
  const operators = useOperators();
  const [running, setRunning] = useState(false);
  // True only while the POSTs go out. `running` covers the whole watch too,
  // during which closing is allowed — the imports continue server-side.
  const [posting, setPosting] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  // Two guards on the run itself:
  //  * runInFlight — `running` is state, so it is still false inside the same
  //    tick as the first click; a double-click would start the loop twice and
  //    import every selected bag twice, under two capture ids.
  //  * alive — the dialog can be closed (or Review unmounted) mid-run. The
  //    loop then stops issuing further imports rather than continuing to
  //    write into a component nobody is looking at.
  const runInFlight = useRef(false);
  const alive = useRef(true);
  // Scans are fired by hand and can overlap (type a path, Scan, retype,
  // Scan). Without a generation the SLOWER response wins whenever it lands
  // last, so the list and the selection can end up describing a folder the
  // operator already moved on from — and the import would then copy it.
  const scanGeneration = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const runScan = async (target?: string) => {
    const wanted = (target ?? path).trim();
    if (!wanted) return;
    if (target) setPath(target);
    const generation = ++scanGeneration.current;
    setScanning(true);
    setScanError(null);
    setScan(null);
    setRows({});
    setScannedPath(wanted);
    try {
      const result = await apiGet<ScanResult>(
        `/imports/scan?path=${encodeURIComponent(wanted)}`,
      );
      if (generation !== scanGeneration.current) return; // a newer scan won
      setScan(result);
      // Pre-select everything that can actually come in: the common case is
      // "import this folder", and the un-importable rows stay visible with
      // their reason rather than being hidden from the count.
      setSelected(new Set(result.bags.filter((b) => b.importable).map((b) => b.path)));
    } catch (err) {
      if (generation !== scanGeneration.current) return;
      setScanError(readCaptureError(err).message || 'Could not scan that folder.');
    } finally {
      if (generation === scanGeneration.current) setScanning(false);
    }
  };

  const runImport = async () => {
    if (!scan) return;
    const targets = scan.bags.filter((b) => b.importable && selected.has(b.path));
    if (targets.length === 0) return;
    if (runInFlight.current) return;
    // Only what was actually typed. An empty string is a label that is present
    // and says nothing; the field is simply left out instead.
    const labels: Record<string, string> = {};
    for (const [key, value] of Object.entries(tags)) {
      const trimmed = value.trim();
      if (trimmed) labels[key] = trimmed;
    }
    // Checked HERE, before a single request. The server refuses a bad label for
    // the whole request and imports nothing, so sending it would spend N round
    // trips to learn one thing about an input sitting on this screen. Caught
    // locally it costs none, keeps what was typed, and — the reason it is not
    // simply left to the 400 — cannot be confused with the per-bag 400 a
    // missing .mcap already produces.
    const problem = labelProblem(labels);
    if (problem) {
      setTagError(problem);
      return;
    }
    setTagError(null);
    runInFlight.current = true;
    setRunning(true);
    setPosting(true);
    let anySucceeded = false;
    // path -> import_id for every accepted POST, watched below.
    const watches = new Map<string, string>();
    for (const bag of targets) {
      if (!alive.current) break; // dialog closed — stop queueing more
      setRows((r) => ({ ...r, [bag.path]: { phase: 'importing' } }));
      try {
        const started = await apiPost<ImportRecord>('/imports', {
          source_path: bag.path,
          move,
          ...labels,
        });
        if (started.import_id) {
          watches.set(bag.path, started.import_id);
          setRows((r) => ({
            ...r,
            [bag.path]: {
              phase: 'copying',
              importId: started.import_id,
              captureId: started.capture_id,
              done: 0,
              total: started.bytes_total ?? null,
            },
          }));
        } else {
          // A server without the import registry in its answer: the ack is
          // all there is to watch, so the row reports what is known.
          setRows((r) => ({
            ...r,
            [bag.path]: { phase: 'done', captureId: started.capture_id },
          }));
          anySucceeded = true;
        }
      } catch (err) {
        // Skip and keep going — this is the whole point of a bulk run.
        setRows((r) => ({
          ...r,
          [bag.path]: {
            phase: 'failed',
            error: readCaptureError(err).message || 'Import failed.',
          },
        }));
      }
    }
    setPosting(false);
    // Watch every accepted import to its ACTUAL end (S3-2). The 202 says only
    // "queued": with two copy slots the tail of a bulk run finishes long after
    // the POSTs, and a copy that dies in staging used to stay ✓ forever with
    // nothing on screen ever learning otherwise. Closing the dialog stops the
    // watch, not the imports — they continue server-side.
    while (alive.current && watches.size > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, importWatchMs ?? IMPORT_WATCH_MS),
      );
      let landedThisRound = false;
      for (const [bagPath, importId] of [...watches]) {
        if (!alive.current) break;
        try {
          const rec = await apiGet<ImportRecord>(
            `/imports/${encodeURIComponent(importId)}`,
          );
          if (rec.state === 'succeeded') {
            watches.delete(bagPath);
            anySucceeded = true;
            landedThisRound = true;
            setRows((r) => ({
              ...r,
              [bagPath]: { phase: 'done', captureId: rec.capture_id },
            }));
          } else if (rec.state === 'failed') {
            watches.delete(bagPath);
            setRows((r) => ({
              ...r,
              [bagPath]: {
                phase: 'failed',
                error: rec.error?.message ?? 'Import failed on the server.',
              },
            }));
          } else {
            setRows((r) => ({
              ...r,
              [bagPath]: {
                phase: 'copying',
                importId,
                captureId: rec.capture_id,
                done: rec.bytes_copied ?? 0,
                total: rec.bytes_total ?? null,
              },
            }));
          }
        } catch {
          // Transient read failure: the import keeps running server-side.
        }
      }
      // As each one LANDS, let Review refetch — the recordings appear as they
      // arrive, not only when the whole bulk run ends.
      if (landedThisRound) onImported();
    }
    runInFlight.current = false;
    setRunning(false);
    if (anySucceeded) onImported();
  };

  const selectable = scan?.bags.filter((b) => b.importable) ?? [];
  const failures = Object.values(rows).filter((s) => s.phase === 'failed').length;
  const imported = Object.values(rows).filter((s) => s.phase === 'done').length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import bags recorded outside kairos"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={posting}>
            {running && !posting
              ? 'Close — imports continue on the server'
              : imported > 0 && !running
                ? 'Close'
                : 'Cancel'}
          </Button>
          <Button
            data-testid="import-run"
            onClick={() => void runImport()}
            disabled={running || selected.size === 0 || path.trim() !== scannedPath}
          >
            {running
              ? `Importing… (${imported + failures}/${selected.size})`
              : `Import ${selected.size} bag${selected.size === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="import-dialog">
        <p className="text-[12.5px] leading-relaxed text-gray-600">
          Give the folder your recordings sit in, <strong>as the server sees
          it</strong> (these are multi-GB directories, so nothing is uploaded
          from this browser). Each bag directory — the one holding the{' '}
          <code>.mcap</code> files and <code>metadata.yaml</code> — becomes one
          recording in Review, copied into kairos&apos;s store.{' '}
          <strong>Only the folders directly inside are checked</strong> — for a
          tree like <code>incoming/&lt;date&gt;/&lt;session&gt;/</code>, name
          the <code>&lt;date&gt;</code> folder. Your folder is left untouched
          unless you choose Move.
        </p>

        <div className="flex gap-2">
          <input
            aria-label="import source folder"
            data-testid="import-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              // Same guard as the Scan button: a rescan mid-run would clear
              // the list and the per-row progress of imports still in flight.
              if (e.key === 'Enter' && path.trim() && !running && !scanning) {
                void runScan();
              }
            }}
            placeholder="/data/incoming-bags"
            className="w-full rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-600 focus:outline-none"
          />
          <Button
            data-testid="import-scan"
            onClick={() => void runScan()}
            disabled={scanning || running || !path.trim()}
          >
            {scanning ? 'Scanning…' : 'Scan'}
          </Button>
        </div>

        {scanError && (
          <p data-testid="import-scan-error" role="alert" className="text-sm text-red-700">
            {scanError}
          </p>
        )}

        {scan && path.trim() !== scannedPath && (
          <p
            data-testid="import-stale-scan"
            role="alert"
            className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
          >
            The list below is for <code>{scannedPath}</code>, not the folder in
            the box. Scan again before importing.
          </p>
        )}

        {scan && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-[12.5px] text-gray-600" data-testid="import-summary">
                {scan.bags.length} director
                {scan.bags.length === 1 ? 'y' : 'ies'} found · {scan.importable} can be
                imported
              </span>
              <div className="flex-1" />
              <label className="flex items-center gap-1.5 text-[12.5px] text-gray-600">
                <input
                  type="radio"
                  name="import-mode"
                  checked={!move}
                  onChange={() => setMove(false)}
                  disabled={running}
                />
                Copy (leaves your folder as it is)
              </label>
              <label className="flex items-center gap-1.5 text-[12.5px] text-gray-600">
                <input
                  type="radio"
                  name="import-mode"
                  data-testid="import-mode-move"
                  checked={move}
                  onChange={() => setMove(true)}
                  disabled={running}
                />
                Move (deletes the source after a successful import)
              </label>
            </div>

            {/* Applied to every bag in THIS import (the server stamps them on
                each capture's birth manifest). Said once, above the three
                fields, rather than three times inside their placeholders. */}
            <div className="flex flex-col gap-1.5 rounded-control border border-gray-200 bg-gray-50/70 px-3 py-2.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-gray-500">
                Labels for every bag in this import (optional)
              </span>
              <div className="grid grid-cols-3 gap-2">
                {TAG_FIELDS.map((field) => (
                  <input
                    key={field.key}
                    type="text"
                    data-testid={`import-tag-${field.key}`}
                    aria-label={field.label}
                    list={field.key === 'operator' ? 'import-tag-operators' : undefined}
                    value={tags[field.key]}
                    placeholder={field.label}
                    disabled={running}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTags((cur) => ({ ...cur, [field.key]: value }));
                      // The refusal was about what was there before.
                      setTagError(null);
                    }}
                    className="rounded-control border border-gray-200 px-2 py-1 text-[12.5px] text-gray-800 focus:border-teal-600 focus:outline-none disabled:bg-gray-100"
                  />
                ))}
              </div>
              {/* The roster is a convenience, not a constraint: an import may
                  well predate whoever is on it, so typing a new name stays
                  allowed. */}
              <datalist id="import-tag-operators">
                {operators.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              {tagError ? (
                <span
                  role="alert"
                  data-testid="import-tag-error"
                  className="rounded-control border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900"
                >
                  {tagError} Nothing was imported — fix the labels and run it again.
                </span>
              ) : (
                <span className="text-[11px] leading-snug text-gray-500">
                  A bag recorded outside kairos carries no operator or task of its
                  own. Left blank, it arrives without them.
                </span>
              )}
            </div>

            {scan.truncated && (
              <p
                data-testid="import-truncated"
                role="alert"
                className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
              >
                That folder holds more directories than one scan reports —
                the list below is INCOMPLETE. Name a subfolder to see the rest.
              </p>
            )}

            {(scan.nested?.length ?? 0) > 0 && (
              <div
                data-testid="import-nested-hint"
                className="flex flex-col gap-1.5 rounded-control border border-gray-200 bg-gray-50 px-3 py-2.5"
              >
                <span className="text-[12px] text-gray-700">
                  {scan.bags.length === 0
                    ? 'No recordings directly here, but these subfolders hold some:'
                    : 'These subfolders hold more recordings one level down:'}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {scan.nested!.map((n) => (
                    <button
                      key={n.path}
                      type="button"
                      data-testid={`import-nested-${n.name}`}
                      disabled={scanning || running}
                      onClick={() => void runScan(n.path)}
                      className="rounded-control border border-gray-300 bg-white px-2.5 py-1 font-mono text-[11.5px] text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                    >
                      {n.name} <span className="text-gray-500">({n.bags})</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ul
              className="max-h-72 overflow-auto rounded-control border border-gray-200"
              data-testid="import-list"
            >
              {scan.bags.length === 0 && (
                <li className="px-3 py-3 text-[12.5px] text-gray-500">
                  No rosbag directly inside that folder. Bag directories are
                  the ones holding the .mcap files; only one level down is
                  checked, so name the folder those directories sit in.
                </li>
              )}
              {scan.bags.map((bag) => {
                const state = rows[bag.path] ?? { phase: 'idle' };
                return (
                  <li
                    key={bag.path}
                    data-testid={`import-row-${bag.name}`}
                    className={cn(
                      'flex items-start gap-2.5 border-t border-gray-50 px-3 py-2 first:border-t-0',
                      !bag.importable && 'bg-gray-50',
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={`import ${bag.name}`}
                      className="mt-1"
                      checked={selected.has(bag.path)}
                      disabled={!bag.importable || running}
                      onChange={(e) =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(bag.path);
                          else next.delete(bag.path);
                          return next;
                        })
                      }
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate font-mono text-[12.5px] text-gray-800">
                        {bag.name}
                      </span>
                      {bag.importable ? (
                        <span className="text-[11.5px] text-gray-500">
                          {summarize(bag)}
                        </span>
                      ) : (
                        <span className="text-[11.5px] text-amber-700">
                          {bag.reason}
                          {bag.remedy && (
                            <>
                              {' '}
                              <code className="font-mono text-gray-600">
                                {bag.remedy}
                              </code>
                            </>
                          )}
                        </span>
                      )}
                      {state.phase === 'failed' && (
                        <span
                          data-testid={`import-failed-${bag.name}`}
                          className="text-[11.5px] font-semibold text-red-700"
                        >
                          Failed — {state.error}
                        </span>
                      )}
                    </div>
                    <span className="shrink-0 text-[11px] font-semibold">
                      {state.phase === 'importing' && (
                        <span className="text-teal-700">queueing…</span>
                      )}
                      {state.phase === 'copying' && (
                        <span className="text-teal-700">
                          copying…
                          {state.total
                            ? ` ${Math.min(
                                100,
                                Math.round((state.done / state.total) * 100),
                              )}%`
                            : ''}
                        </span>
                      )}
                      {state.phase === 'done' && (
                        <span className="text-teal-700">imported ✓</span>
                      )}
                      {state.phase === 'failed' && (
                        <span className="text-red-700">failed</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>

            {selectable.length > 0 && !running && (
              <p className="text-[11.5px] text-gray-500">
                Imported recordings arrive with no operator or task — label them
                in Review. Large folders copy in the background; the recordings
                appear as each one lands.
              </p>
            )}

            {failures > 0 && !running && (
              <p role="alert" data-testid="import-failures" className="text-sm text-red-700">
                {failures} folder{failures === 1 ? '' : 's'} failed and{' '}
                {failures === 1 ? 'was' : 'were'} skipped — each one says why
                above. The rest were imported.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
