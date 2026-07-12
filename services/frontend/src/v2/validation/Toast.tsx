// Local toast for the mock-only affordances on this screen (New run, Compare
// runs, Export CSV, Promote to Standard) — same visual as the Collect screen's
// toast (v2/collect/Modals.tsx) but this screen owns its own instance rather
// than importing across screen directories.
export function Toast({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div className="fixed bottom-[26px] left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-control bg-gray-900 px-[18px] py-[11px] text-sm font-medium text-gray-50 shadow-float">
      <span className="h-[7px] w-[7px] rounded-sm bg-teal-400" />
      {message}
    </div>
  );
}
