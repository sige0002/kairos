// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Deployment-wide reads that belong to no one screen: host/disk facts, the
// advisory retention candidates, and ROS 2 graph discovery.

import { apiGet, type RequestOptions } from './client';
import type { RetentionInfo, SystemInfo, TopicInfo } from './types';

/** NOTE the absolute path. `joinUrl` passes anything starting with `/api/`
 *  through untouched, so this call deliberately does NOT follow a relocated
 *  `endpoints.api` base the way the relative paths below do. Kept verbatim
 *  because that is the URL the callers have always requested. */
export function getSystemInfo(opts: RequestOptions = {}): Promise<SystemInfo> {
  return apiGet<SystemInfo>('/api/v1/system', opts);
}

export function getRetention(opts: RequestOptions = {}): Promise<RetentionInfo> {
  return apiGet<RetentionInfo>('/retention', opts);
}

/** Graph discovery. Older backends answered with a bare array and newer ones
 *  with an envelope, so the union is the contract — callers normalize. */
export type TopicListResponse =
  | TopicInfo[]
  | { topics?: TopicInfo[]; items?: TopicInfo[] };

export function getTopics(opts: RequestOptions = {}): Promise<TopicListResponse> {
  return apiGet<TopicListResponse>('/topics', opts);
}
