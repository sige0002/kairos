// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Local state for the Settings > External controls section (#43). Reads the
// installation-global channel→action mapping from the SHARED plans store and
// writes it back, so an edit here re-resolves Collect's HUD and key handling
// immediately (useExternalActions reads the same store) and is pushed to every
// terminal. Kept separate from useSettingsState so that hook does not grow a
// second settings domain.

import { useCallback } from 'react';
import {
  cloneExternalControls,
  DEFAULT_EXTERNAL_CONTROLS,
  type ExternalControlAction,
  type ExternalControlSlot,
  type ExternalControlState,
  type ExternalControlsConfig,
} from '../collect/machine/externalControlConfig';
import {
  setExternalControls,
  useExternalControls,
  useExternalControlsInvalid,
} from '../plans';
import { useToast } from '../shared/useToast';
import { i18n } from '../../i18n';

export interface ExternalControlsSettings {
  config: ExternalControlsConfig;
  /** A stored mapping could not be read; the safe default stands in. */
  invalid: boolean;
  setChannel: (
    state: ExternalControlState,
    slot: ExternalControlSlot,
    action: ExternalControlAction,
  ) => void;
  resetToDefault: () => void;
  toast: string;
}

export function useExternalControlsSettings(): ExternalControlsSettings {
  const config = useExternalControls();
  const invalid = useExternalControlsInvalid();
  const { toast, showToast } = useToast();

  const setChannel = useCallback(
    (
      state: ExternalControlState,
      slot: ExternalControlSlot,
      action: ExternalControlAction,
    ) => {
      // The selects only offer allowlisted, non-duplicate actions; the store
      // re-validates as the backstop for a future caller.
      setExternalControls({
        ...config,
        [state]: { ...config[state], [slot]: action },
      });
    },
    [config],
  );

  const resetToDefault = useCallback(() => {
    setExternalControls(cloneExternalControls(DEFAULT_EXTERNAL_CONTROLS));
    showToast(i18n.t('settings:externalControls.resetToast'));
  }, [showToast]);

  return { config, invalid, setChannel, resetToDefault, toast };
}
