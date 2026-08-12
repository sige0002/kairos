// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Shared configuration reads and the robot switch.
//
// `/config/options` is the deployment's menu (which robots exist, which is
// active); `/config/select` is the only write that changes it, and it answers
// with the same shape so a caller can seed its cache from the reply. The
// per-robot and per-aspect files hang off those two.

import { apiGet, apiPost, type RequestOptions } from './client';
import type { ConfigOptions, RecordingConfigPayload, RobotConfig } from './types';

export function getConfigOptions(opts: RequestOptions = {}): Promise<ConfigOptions> {
  return apiGet<ConfigOptions>('/config/options', opts);
}

/** Switch the active robot (and any other config vars). Answers with the new
 *  options, so the reply is the post-switch truth. */
export function selectConfig(vars: unknown): Promise<ConfigOptions> {
  return apiPost<ConfigOptions>('/config/select', vars);
}

export function getRobotConfig(
  robot: string,
  opts: RequestOptions = {},
): Promise<RobotConfig> {
  return apiGet<RobotConfig>(`/config/robots/${encodeURIComponent(robot)}`, opts);
}

/** The resolved recording config for the ACTIVE robot — which topics are
 *  recorded, and the recording-level tuning (compression, split, pre_arm). */
export function getRecordingConfig(
  opts: RequestOptions = {},
): Promise<RecordingConfigPayload> {
  return apiGet<RecordingConfigPayload>('/config/recording', opts);
}
