// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// The store on disk: object_manifest.json, record.json, lifecycle.jsonl.
//
// These are the sidecar truths §13 asks each scenario to corroborate — the
// files that must survive the database, because §8 rebuilds the catalog from
// them. Reading them directly (rather than believing the API's summary of them)
// is the point: a rebuild that works only because the DB happened to be intact
// is not the property the contract is claiming.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stackEnv } from './stack';

export interface ObjectManifest {
  schema_version: number;
  capture_id: string;
  run_id: string;
  state: string;
  digest_state: 'pending' | 'complete';
  files: { path: string; size: number; sha256: string }[] | null;
  manifest_digest: string | null;
  message_count: number | null;
  bytes: number | null;
  ended_at: string | null;
}

export interface RecordSidecar {
  schema_version: number;
  capture_id: string;
  revision: number;
  task_result: string | null;
  failure_reason: string | null;
  quality: string | null;
  quality_source: string | null;
  review_status: string;
  updated_at: string;
}

export interface LedgerEvent {
  schema_version: number;
  event_id: string;
  kind: string;
  capture_id: string | null;
  at: string;
  [k: string]: unknown;
}

const dataDir = (): string => stackEnv().dataDir;

export const store = {
  objectsDir: (): string => join(dataDir(), 'objects'),
  captureDir: (id: string): string => join(dataDir(), 'objects', id),
  captureExists: (id: string): boolean => existsSync(store.captureDir(id)),
  trashExists: (id: string): boolean => existsSync(join(dataDir(), '.trash', id)),
  dbExists: (): boolean => existsSync(join(dataDir(), 'kairos.db')),

  captureIds(): string[] {
    const dir = store.objectsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  },

  manifest(id: string): ObjectManifest {
    const p = join(store.captureDir(id), 'object_manifest.json');
    if (!existsSync(p)) throw new Error(`no object_manifest.json for ${id} (${p})`);
    return JSON.parse(readFileSync(p, 'utf8')) as ObjectManifest;
  },

  /** `record.json` — absent until the first review save (§4: "未 review = ファイル無し"). */
  record(id: string): RecordSidecar | null {
    const p = join(store.captureDir(id), 'record.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as RecordSidecar;
  },

  recordPath: (id: string): string => join(store.captureDir(id), 'record.json'),

  /** Every well-formed line of lifecycle.jsonl, oldest first. */
  ledger(): LedgerEvent[] {
    const p = join(dataDir(), 'lifecycle.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LedgerEvent);
  },

  ledgerFor(id: string, kind?: string): LedgerEvent[] {
    return store
      .ledger()
      .filter((e) => e.capture_id === id && (kind === undefined || e.kind === kind));
  },

  /**
   * A pipeline's verdict for one capture — `report/<pipeline>/<capture_id>/
   * summary.json` (§10.5, and the `outputs` every pipeline declares).
   *
   * Null until the job has written it, so a caller can poll rather than guess
   * when the run is done. Shape is per-pipeline by design (the plugin contract
   * fixes only `result`), hence the loose type.
   */
  reportSummary(pipeline: string, captureId: string): Record<string, unknown> | null {
    const p = join(dataDir(), 'report', pipeline, captureId, 'summary.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  },

  instanceId(): string {
    const p = join(dataDir(), 'instance.json');
    return (JSON.parse(readFileSync(p, 'utf8')) as { instance_id: string }).instance_id;
  },

  /**
   * Plant a §3.4 failed-start sidecar (`objects/<id>.failed.json`).
   *
   * The shape is copied verbatim from one the recorder actually produced: when
   * arming fails before topic-type discovery finishes, every `type` is an
   * EXPLICIT null. Inventing a tidier sidecar here would test a case that does
   * not occur — and the explicit null is precisely what the rebuild has to
   * survive, because §8 requires it to make a `state='failed'` row from this
   * file.
   */
  writeFailedStart(captureId: string): string {
    const path = join(store.objectsDir(), `${captureId}.failed.json`);
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: 2,
        capture_id: captureId,
        source_instance_id: store.instanceId(),
        run_id: 'run_20260101_000000',
        state: 'failed',
        operator: 'e2e',
        task: 'failed-start',
        robot: 'airoa_hsr',
        started_at: '2026-01-01T00:00:00.000Z',
        ended_at: '2026-01-01T00:00:02.000Z',
        topics: [{ name: '/hsrb/joint_states', type: null, qos: null }],
        message_count: null,
        bytes: null,
        compression: 'none',
        split: null,
        dropped_messages: null,
        integrity: 'failed',
        error: 'arming: failed to shutdown: rcl_shutdown already called',
        digest_state: 'pending',
        files: null,
        manifest_digest: null,
      }),
    );
    return path;
  },

  removeIfPresent(path: string): void {
    if (existsSync(path)) rmSync(path);
  },

  // ---- the archive side (§6.1, scenario 6) ---------------------------------
  // The acceptance archive root: the container sees /archive, the host sees
  // e2e/.run/archive (mounted by e2e/compose.archive.yaml, wiped by reset).

  archiveDir: (): string => join(dataDir(), '..', 'archive'),

  /** A container-side destination (`/archive/…` — what the ledger and the UI
   *  say) translated to where those bytes are on the host. */
  hostArchivePath(containerPath: string): string {
    if (!containerPath.startsWith('/archive')) {
      throw new Error(`not under the acceptance archive root: ${containerPath}`);
    }
    return join(store.archiveDir(), containerPath.slice('/archive'.length));
  },

  /** The dataset_manifest.json an archive run left at *containerDest*. */
  datasetManifest(containerDest: string): DatasetArchiveManifest {
    const p = join(store.hostArchivePath(containerDest), 'dataset_manifest.json');
    if (!existsSync(p)) throw new Error(`no dataset_manifest.json at ${p}`);
    return JSON.parse(readFileSync(p, 'utf8')) as DatasetArchiveManifest;
  },

  datasetManifestBytes(containerDest: string): Buffer {
    return readFileSync(join(store.hostArchivePath(containerDest), 'dataset_manifest.json'));
  },
};

export interface DatasetArchiveManifest {
  schema_version: number;
  kind: string;
  dataset_id: string;
  name: string | null;
  status: 'archiving' | 'complete';
  started_event_id: string | null;
  completed_at: string | null;
  members: {
    dir: string;
    display_index: number;
    membership_id: string;
    capture_id: string;
    files: { path: string; size: number; sha256: string }[] | null;
    bytes: number | null;
    capture_archived_event_id: string | null;
  }[];
  totals: { members: number; bytes: number };
}
