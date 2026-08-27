// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

import type { en } from './en';

type ResourceShape<T> = {
  [Key in keyof T]: T[Key] extends string ? string : ResourceShape<T[Key]>;
};

export const ja = {
  common: {
    tabs: {
      collect: '収録',
      review: 'レビュー',
      datasets: 'データセット',
      validation: '検証',
      monitor: '監視',
      settings: '設定',
    },
    actions: {
      openInNewWindow: '現在のタブを別ウィンドウで開く',
      openTabInNewWindow: '{{tab}} を別ウィンドウで開く',
      backToConsole: 'kairos コンソールに戻る',
    },
    count: {
      member_one: '{{formattedCount}} 件',
      member_other: '{{formattedCount}} 件',
      memberLabel_one: '件',
      memberLabel_other: '件',
    },
  },
  collect: { foundation: '収録' },
  review: { foundation: 'レビュー' },
  datasets: { foundation: 'データセット' },
  validation: { foundation: '検証' },
  monitor: { foundation: '監視' },
  settings: {
    categories: {
      general: '一般',
      collection: '収録',
      data: 'データ',
      workspace: 'ワークスペース',
      notifications: '通知',
      advanced: '詳細',
    },
    sections: {
      language: '言語',
    },
    language: {
      title: '言語',
      description:
        'このブラウザにすぐ適用されます。収録、共有設定、現在の作業は変更しません。',
      options: {
        en: 'English',
        ja: '日本語',
      },
      statusPersistent: 'このコンソールでは {{language}} を使用しています。',
      statusTemporary:
        'このページでは {{language}} を使用しています。ブラウザの保存領域を使えないため、再読み込み後にもう一度選択してください。',
    },
  },
} as const satisfies ResourceShape<typeof en>;
