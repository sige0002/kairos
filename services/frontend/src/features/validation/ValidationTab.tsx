// Validation tab (handoff 検証): runs the `fast_validation` pipeline against a
// selected recording and shows the required-topic pass/fail breakdown. Layout
// mirrors the handoff: a result card (left) + a run/run-pipeline launcher and
// raw output (right). Every job carries a run_id (the backend requires it), so
// this picks a Run explicitly — unlike the old generic pipeline form.

import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import type {
  ConfigOptions,
  JobResult,
  JobStatus,
  Page,
  RunSummary,
} from '../../api/types';
import { ErrorMessage } from '../../components/ErrorMessage';
import { Badge, Button, Card, SectionLabel, StatusDot } from '../../components/ui';

const PIPELINE = 'fast_validation';
const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

interface RequiredTopic {
  name: string;
  type?: string | null;
}

function ResultCard({ jobId, required }: { jobId: string; required: RequiredTopic[] }) {
  const statusQuery = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobStatus>(`/jobs/${encodeURIComponent(jobId)}/status`, { signal }),
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.state) ? false : 1500),
  });
  const terminal = !!statusQuery.data && TERMINAL.has(statusQuery.data.state);

  const resultQuery = useQuery({
    queryKey: queryKeys.jobResult(jobId),
    queryFn: ({ signal }) =>
      apiGet<JobResult>(`/jobs/${encodeURIComponent(jobId)}/result`, { signal }),
    enabled: terminal,
  });

  if (!terminal || resultQuery.isPending) {
    return (
      <Card className="p-[18px]">
        <p className="text-sm text-gray-500">
          {statusQuery.data?.state === 'running' || !terminal
            ? '検証を実行中…'
            : '結果を取得中…'}
        </p>
      </Card>
    );
  }
  if (resultQuery.isError) return <ErrorMessage error={resultQuery.error} />;

  const summary = resultQuery.data.summary;
  const missing = summary.missing ?? [];
  const missingNames = new Set(missing.map((m) => m.name));
  const pass = summary.result === 'pass';
  // Prefer the template's full required list (so OK rows show too); fall back to
  // just the missing entries if the template wasn't resolvable.
  const rows: RequiredTopic[] = required.length > 0 ? required : missing;
  const found = Math.max(0, rows.length - missing.length);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-gray-100 px-[18px] py-4">
        <SectionLabel>検証結果</SectionLabel>
        <span className="font-mono text-[11.5px] text-gray-400">
          {found}/{rows.length} required
        </span>
        <div className="flex-1" />
        <Badge tone={pass ? 'green' : 'red'} dot>
          {pass ? 'PASS' : 'FAIL'}
        </Badge>
      </div>
      <div className="px-[18px] py-1.5">
        <div className="grid grid-cols-[1fr_64px_44px] gap-3 border-b border-gray-100 py-2 text-[10px] uppercase tracking-[0.05em] text-gray-400">
          <span>必須トピック</span>
          <span className="text-right">期待</span>
          <span className="text-right">判定</span>
        </div>
        {rows.map((t) => {
          const ng = missingNames.has(t.name);
          return (
            <div
              key={t.name}
              className="grid grid-cols-[1fr_64px_44px] items-center gap-3 border-b border-gray-50 py-2.5"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <StatusDot tone={ng ? 'red' : 'green'} />
                <span className="truncate font-mono text-[12.5px] text-gray-700">{t.name}</span>
              </span>
              <span className="truncate text-right font-mono text-[10.5px] text-gray-400">
                {t.type ?? 'any'}
              </span>
              <span
                className={`text-right font-mono text-[13px] font-semibold ${
                  ng ? 'text-red-600' : 'text-green-600'
                }`}
              >
                {ng ? '✕' : '✓'}
              </span>
            </div>
          );
        })}
      </div>
      {summary.extra && summary.extra.length > 0 && (
        <p className="px-[18px] py-2.5 font-mono text-[11px] text-gray-400">
          +{summary.extra.length} extra topics not required
        </p>
      )}
    </Card>
  );
}

export function ValidationTab() {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState('');
  const [template, setTemplate] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: queryKeys.runs(undefined),
    queryFn: ({ signal }) =>
      apiGet<Page<RunSummary>>('/runs', { signal, query: { limit: 50 } }),
    placeholderData: keepPreviousData,
  });
  const runs = useMemo(
    () => (runsQuery.data?.items ?? []).filter((r) => r.state === 'completed'),
    [runsQuery.data],
  );

  const optionsQuery = useQuery({
    queryKey: queryKeys.configOptions,
    queryFn: ({ signal }) => apiGet<ConfigOptions>('/config/options', { signal }),
  });
  const templates = optionsQuery.data?.validation.options ?? [];
  const activeTemplate = template || optionsQuery.data?.validation.active || templates[0]?.id || '';
  const requiredTopics =
    templates.find((t) => t.id === activeTemplate)?.required_topics ?? [];

  const submitMutation = useMutation({
    mutationFn: (body: { run_id: string; params: { template: string } }) =>
      apiPost<JobStatus>('/jobs', { pipeline: PIPELINE, ...body }),
    onSuccess: (job) => {
      setJobId(job.job_id);
      queryClient.setQueryData(queryKeys.job(job.job_id), job);
    },
  });

  const canRun = !!runId && !submitMutation.isPending;

  return (
    <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1.5fr_1fr]">
      <section aria-label="validation result" className="flex flex-col gap-3">
        <SectionLabel>検証</SectionLabel>
        {jobId ? (
          <ResultCard jobId={jobId} required={requiredTopics} />
        ) : (
          <Card className="p-8 text-center text-sm text-gray-500">
            右の「検証を実行」から対象 Run とテンプレートを選んで起動してください。
          </Card>
        )}
      </section>

      <section aria-label="run validation" className="flex flex-col gap-3">
        <Card className="flex flex-col gap-3 p-[18px]">
          <SectionLabel>検証を実行</SectionLabel>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] font-medium text-gray-500">パイプライン</span>
            <span className="rounded-control border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-sm text-gray-700">
              {PIPELINE}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] font-medium text-gray-500">対象 Run</span>
            <select
              aria-label="run"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              className="rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none"
            >
              <option value="">
                {runsQuery.isPending ? 'Loading…' : runs.length ? '— 選択 —' : '完了した Run なし'}
              </option>
              {runs.map((r) => (
                <option key={r.run_id} value={r.run_id}>
                  {r.run_id}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[11px] font-medium text-gray-500">テンプレート</span>
            <select
              aria-label="template"
              value={activeTemplate}
              onChange={(e) => setTemplate(e.target.value)}
              disabled={templates.length === 0}
              className="rounded-control border border-gray-200 px-2 py-1.5 font-mono text-sm focus:border-teal-500 focus:outline-none"
            >
              {templates.length === 0 ? (
                <option value="">テンプレート未登録</option>
              ) : (
                templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} (v{t.version}) · {t.required_topics.length} topics
                  </option>
                ))
              )}
            </select>
          </label>
          {submitMutation.isError && <ErrorMessage error={submitMutation.error} />}
          <Button
            type="button"
            disabled={!canRun}
            onClick={() =>
              submitMutation.mutate({
                run_id: runId,
                params: { template: activeTemplate },
              })
            }
          >
            {submitMutation.isPending ? '起動中…' : '検証を起動'}
          </Button>
        </Card>

        {jobId && (
          <Card className="p-[18px]">
            <SectionLabel>出力</SectionLabel>
            <p className="mt-2 font-mono text-[11.5px] text-gray-500">
              /data/report/fast_validation/{runId}/summary.json
            </p>
          </Card>
        )}
      </section>
    </div>
  );
}
