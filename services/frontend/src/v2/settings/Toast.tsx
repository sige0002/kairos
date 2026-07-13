// Same floating-toast look as the other v2 screens (see
// src/v2/collect/Modals.tsx / src/v2/datasets/Toast.tsx) — kept local to this
// directory per the multi-agent split (each screen owns its own toast).

export function SettingsToast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      data-testid="settings-toast"
      className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-gray-900 px-[18px] py-[11px] text-sm font-medium text-gray-50 shadow-float"
    >
      <span className="h-[7px] w-[7px] rounded-sm bg-teal-400" />
      {message}
    </div>
  );
}
