// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Settings > External controls (#43) — the installation-global mapping of the
// three logical external channels (LEFT / CENTER / RIGHT) to the action each
// performs in each Collect state. The editor offers ONLY the actions valid for
// a state (the same allowlist the resolver and the server enforce) and blocks
// assigning one action to two channels of a state, so an unsafe or ambiguous
// layout cannot be stored. Edits funnel through the shared plans store:
// Collect's HUD and key handling re-resolve immediately, and the layout is
// pushed to every terminal.
//
// HCD notes: the physical device is never named — a keyboard chord, a macro
// pad, or a programmable foot pedal may all emit the three logical inputs;
// `None` reads as "does nothing here"; and Retake's consequence (discard the
// current take and re-record) is stated, because it is the one destructive
// action an operator can bind to a pedal.

import { Button, Notice, Select, SettingsSection } from '../../components/ui';
import { useTranslation } from 'react-i18next';
import {
  ALLOWED_ACTIONS,
  EXTERNAL_CONTROL_SLOTS,
  EXTERNAL_CONTROL_STATES,
  type ExternalControlAction,
} from '../collect/machine/externalControlConfig';
import { Toast } from '../shared/Toast';
import { useExternalControlsSettings } from './useExternalControlsSettings';

export function ExternalControlsSection() {
  const { t } = useTranslation('settings');
  const { config, invalid, setChannel, resetToDefault, toast } =
    useExternalControlsSettings();

  return (
    <SettingsSection
      title={t('externalControls.title')}
      description={t('externalControls.description')}
      className="lg:col-span-2"
      data-testid="settings-ext-controls"
    >
      {invalid && (
        <Notice
          tone="warning"
          live="assertive"
          data-testid="ext-controls-invalid"
          className="mx-3 mt-3 text-[12px]"
        >
          {t('externalControls.invalid')}
        </Notice>
      )}
      <div className="flex flex-col gap-3 p-3">
        {EXTERNAL_CONTROL_STATES.map((state) => (
          <div
            key={state}
            data-testid={`ext-control-state-${state}`}
            className="rounded-control border border-border bg-surface-muted px-3 py-2.5"
          >
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-text-secondary">
                {t(`externalControls.states.${state}`)}
              </h3>
              {state === 'result' && (
                <span className="text-[11px] text-text-muted">
                  {t('externalControls.retakeHelp')}
                </span>
              )}
              {state === 'failure_reason' && (
                <span className="text-[11px] text-text-muted">
                  {t('externalControls.shortcutsHelp')}
                </span>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {EXTERNAL_CONTROL_SLOTS.map((slot) => {
                const current = config[state][slot];
                const takenElsewhere = (action: ExternalControlAction) =>
                  action !== 'none' &&
                  EXTERNAL_CONTROL_SLOTS.some(
                    (other) => other !== slot && config[state][other] === action,
                  );
                return (
                  <label key={slot} className="flex flex-col gap-1">
                    <span className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-text-muted">
                      {slot}
                    </span>
                    <Select
                      data-testid={`ext-control-${state}-${slot}`}
                      value={current}
                      onChange={(event) =>
                        setChannel(
                          state,
                          slot,
                          event.target.value as ExternalControlAction,
                        )
                      }
                      className="h-[34px] w-full px-2 text-[12.5px] disabled:opacity-40"
                    >
                      {(
                        ['none', ...ALLOWED_ACTIONS[state]] as ExternalControlAction[]
                      ).map((action) => (
                        <option
                          key={action}
                          value={action}
                          disabled={takenElsewhere(action)}
                        >
                          {t(`externalControls.actions.${action}`)}
                        </option>
                      ))}
                    </Select>
                  </label>
                );
              })}
            </div>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={resetToDefault}
          data-testid="ext-controls-reset"
          className="self-start border-dashed border-border-strong px-3 py-2 text-[12.5px] text-accent hover:bg-interaction-selected"
        >
          {t('externalControls.reset')}
        </Button>
      </div>
      <Toast message={toast} testId="ext-controls-toast" />
    </SettingsSection>
  );
}
