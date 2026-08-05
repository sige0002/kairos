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

import { useState } from 'react';
import { apiGet, apiPost } from '../../api/client';
import { readCaptureError } from '../captures/errors';
import { Button, Modal, cn } from '../../components/ui';
import { formatBytes } from './format';

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
  /** The walk hit its depth or breadth bound — the list is INCOMPLETE. */
  truncated?: boolean;
  max_depth?: number;
}

type RowState =
  | { phase: 'idle' }
  | { phase: 'importing' }
  | { phase: 'done'; captureId?: string }
  | { phase: 'failed'; error: string };

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
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [move, setMove] = useState(false);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<Record<string, RowState>>({});

  const runScan = async () => {
    setScanning(true);
    setScanError(null);
    setScan(null);
    setRows({});
    try {
      const result = await apiGet<ScanResult>(
        `/imports/scan?path=${encodeURIComponent(path.trim())}`,
      );
      setScan(result);
      // Pre-select everything that can actually come in: the common case is
      // "import this folder", and the un-importable rows stay visible with
      // their reason rather than being hidden from the count.
      setSelected(new Set(result.bags.filter((b) => b.importable).map((b) => b.path)));
    } catch (err) {
      setScanError(readCaptureError(err).message || 'Could not scan that folder.');
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!scan) return;
    const targets = scan.bags.filter((b) => b.importable && selected.has(b.path));
    if (targets.length === 0) return;
    setRunning(true);
    let anySucceeded = false;
    for (const bag of targets) {
      setRows((r) => ({ ...r, [bag.path]: { phase: 'importing' } }));
      try {
        // POST returns 202 as soon as the copy is queued; the capture appears
        // in Review when the staged copy has been moved into place. We report
        // "queued" honestly rather than claiming the bytes have landed.
        const started = await apiPost<{ capture_id?: string }>('/imports', {
          source_path: bag.path,
          move,
        });
        setRows((r) => ({
          ...r,
          [bag.path]: { phase: 'done', captureId: started.capture_id },
        }));
        anySucceeded = true;
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
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {imported > 0 && !running ? 'Close' : 'Cancel'}
          </Button>
          <Button
            data-testid="import-run"
            onClick={() => void runImport()}
            disabled={running || selected.size === 0}
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
          <strong>Subfolders are searched too</strong>, so a tree like{' '}
          <code>incoming/&lt;date&gt;/&lt;session&gt;/</code> works from the
          top. Your folder is left untouched unless you choose Move.
        </p>

        <div className="flex gap-2">
          <input
            aria-label="import source folder"
            data-testid="import-path"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && path.trim()) void runScan();
            }}
            placeholder="/data/incoming-bags"
            className="w-full rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none"
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

            {scan.truncated && (
              <p
                data-testid="import-truncated"
                role="alert"
                className="rounded-control border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800"
              >
                This folder is deeper or larger than the scan looks
                {scan.max_depth ? ` (${scan.max_depth} levels)` : ''} — the list
                below is INCOMPLETE. Point at a subfolder to see the rest.
              </p>
            )}

            <ul
              className="max-h-72 overflow-auto rounded-control border border-gray-200"
              data-testid="import-list"
            >
              {scan.bags.length === 0 && (
                <li className="px-3 py-3 text-[12.5px] text-gray-500">
                  No rosbag found under that folder. Bag directories are the
                  ones holding the .mcap files — subfolders are searched, so
                  point at the top of the tree your recordings live in.
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
                        <span className="text-teal-700">copying…</span>
                      )}
                      {state.phase === 'done' && (
                        <span className="text-teal-700">queued ✓</span>
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
