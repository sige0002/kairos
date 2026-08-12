// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Sadasue Yuki
// Open/closed state of every Collect overlay this hook family owns (pickers,
// modals, the batch menu, the shortcuts sheet), extracted from
// useBatchMachine.ts. Pure UI state: no API calls, no machine dispatches.
// The takeover-stop modal is NOT here — it belongs to the takeover flow.

import { useCallback, useEffect, useState } from 'react';

export function useCollectOverlays({
  ctxEditable,
  condAllowed,
}: {
  ctxEditable: boolean;
  condAllowed: boolean;
}) {
  const [batchMenuOpen, setBatchMenuOpen] = useState(false);
  const [projPickerOpen, setProjPickerOpen] = useState(false);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [endModalOpen, setEndModalOpen] = useState(false);
  const [issueModalOpen, setIssueModalOpen] = useState(false);
  const [robotPickerOpen, setRobotPickerOpen] = useState(false);
  const [condModalOpen, setCondModalOpen] = useState(false);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [targetModalOpen, setTargetModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const toggleBatchMenu = useCallback(() => setBatchMenuOpen((v) => !v), []);
  const openProjPicker = useCallback(() => {
    if (!ctxEditable) return;
    setProjPickerOpen((v) => !v);
    setTaskPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const toggleRobotPicker = useCallback(() => {
    if (!ctxEditable) return;
    setRobotPickerOpen((v) => !v);
    setProjPickerOpen(false);
    setTaskPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  const openTaskPicker = useCallback(() => {
    if (!ctxEditable) return;
    setTaskPickerOpen((v) => !v);
    setProjPickerOpen(false);
    setBatchMenuOpen(false);
  }, [ctxEditable]);
  // The guards above only stop a picker being OPENED. Nothing dismissed one
  // already on screen, so a list opened before Start stayed live over a running
  // recording — and picking from it re-labels the take in flight: with an
  // episode already recorded it routes through rolloverSet, whose "close the
  // old set" PATCH is skipped while recording (only the at-rest phases send it)
  // while the local ROLLOVER_SET runs regardless. Close them when the context
  // stops being editable.
  useEffect(() => {
    if (ctxEditable) return;
    setRobotPickerOpen(false);
    setProjPickerOpen(false);
    setTaskPickerOpen(false);
  }, [ctxEditable]);
  const openCondModal = useCallback(() => {
    if (!condAllowed) return;
    setCondModalOpen(true);
    setBatchMenuOpen(false);
  }, [condAllowed]);
  const openEndModal = useCallback(() => {
    setEndModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openIssueModal = useCallback(() => {
    setIssueModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openResetModal = useCallback(() => {
    setResetModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openTargetModal = useCallback(() => {
    setTargetModalOpen(true);
    setBatchMenuOpen(false);
  }, []);
  const openShortcuts = useCallback(() => setShortcutsOpen(true), []);

  return {
    batchMenuOpen,
    projPickerOpen,
    taskPickerOpen,
    endModalOpen,
    issueModalOpen,
    robotPickerOpen,
    condModalOpen,
    resetModalOpen,
    targetModalOpen,
    shortcutsOpen,
    toggleBatchMenu,
    openProjPicker,
    toggleRobotPicker,
    openTaskPicker,
    openCondModal,
    openEndModal,
    openIssueModal,
    openResetModal,
    openTargetModal,
    openShortcuts,
    // Raw setters for the flows that close or open overlays from business
    // logic (batch menu actions, context rollover, shortcuts, closeModals).
    setBatchMenuOpen,
    setProjPickerOpen,
    setTaskPickerOpen,
    setEndModalOpen,
    setIssueModalOpen,
    setCondModalOpen,
    setResetModalOpen,
    setTargetModalOpen,
    setShortcutsOpen,
  };
}
