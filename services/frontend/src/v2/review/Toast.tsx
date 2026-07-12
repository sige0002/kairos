// Minimal local toast — same look as the Collect screen's (Modals.tsx), kept
// as its own tiny copy per the multi-agent build rules (dedupe happens later).

export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div
      data-testid="review-toast"
      className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-gray-900 px-[18px] py-[11px] text-sm font-medium text-gray-50 shadow-float"
    >
      <span className="h-[7px] w-[7px] rounded-sm bg-teal-400" />
      {message}
    </div>
  );
}
