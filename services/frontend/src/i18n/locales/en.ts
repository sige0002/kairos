// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki

export const en = {
  common: {
    tabs: {
      collect: 'Collect',
      review: 'Review',
      datasets: 'Datasets',
      validation: 'Validation',
      monitor: 'Monitor',
      settings: 'Settings',
    },
    actions: {
      openInNewWindow: 'Open the current tab in its own window',
      openTabInNewWindow: 'Open {{tab}} in a new window',
      backToConsole: 'Back to the kairos console',
    },
    count: {
      member_one: '{{formattedCount}} member',
      member_other: '{{formattedCount}} members',
      memberLabel_one: 'member',
      memberLabel_other: 'members',
    },
  },
  collect: { foundation: 'Collect' },
  review: { foundation: 'Review' },
  datasets: { foundation: 'Datasets' },
  validation: { foundation: 'Validation' },
  monitor: { foundation: 'Monitor' },
  settings: {
    categories: {
      general: 'General',
      collection: 'Collection',
      data: 'Data',
      workspace: 'Workspace',
      notifications: 'Notifications',
      advanced: 'Advanced',
    },
    sections: {
      language: 'Language',
    },
    language: {
      title: 'Language',
      description:
        'Applies immediately on this browser. It does not change recording, shared settings, or your current work.',
      options: {
        en: 'English',
        ja: '日本語',
      },
      statusPersistent: 'Using {{language}} for this console.',
      statusTemporary:
        'Using {{language}} for this page. Browser storage is unavailable, so choose it again after reload.',
    },
  },
} as const;
