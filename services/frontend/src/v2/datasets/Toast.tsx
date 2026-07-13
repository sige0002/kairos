// Minimal toast for the Datasets screen. Mirrors the dark bottom-center pill
// used by Collect's Modals.tsx, duplicated locally per the v2-screen-agent
// convention of not reaching into other screens' directories.

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      role="status"
      data-testid="toast"
      className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-gray-900 px-[18px] py-[11px] text-sm font-medium text-gray-50 shadow-float"
    >
      <span className="h-[7px] w-[7px] rounded-sm bg-teal-400" />
      {message}
    </div>
  );
}
