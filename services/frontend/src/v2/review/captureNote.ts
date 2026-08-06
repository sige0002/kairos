// How a capture's own recorded outcome should READ.
//
// `capture.error` is the recorder's account of one recording, carried in the
// manifest's single free-text field. That field is the only place a recorder
// has to say anything, so it carries two different kinds of news: a fault, and
// a take that ended exactly where it was configured to end. The panel used to
// colour by whether the field was SET, which made the second look like the
// first — a `completed` recording, whose own backend comment says "the
// recorder's own code says no error occurred", arriving in a red fault box.
//
// So severity is read from the CODE. Deliberately not by special-casing the
// one code that prompted this: the next benign code the backend files here
// would inherit the same lie, and the surface should be asking "what does this
// mean" rather than holding a list of exceptions.
//
// This is NOT the job of `captures/errors.ts`. That module reads API REFUSALS
// and answers "what should the operator do next"; its severities are `warning`
// and `destructive`, both of which are bad, and it has no way to say "this is
// simply what happened". A manifest note has no next step for the UI to add
// (see the comment at the panel) — only a meaning.

export type CaptureNoteSeverity = 'fault' | 'notice';

/**
 * Codes that are NOT faults, and the words that say so. Anything absent is a
 * fault: an unrecognised code is exactly when guessing "probably fine" costs
 * the most, because a genuine fault would arrive dressed as a routine note.
 * A new BENIGN code costs only the next reader adding a line here.
 */
const NOTICES: Record<string, string> = {
  // The recorder stopped itself at MAX_RECORD_SECONDS / MAX_RECORD_BYTES. The
  // take is complete and usable; the cap did the job it was set to do.
  auto_stopped: 'Stopped at the configured limit',
};

export interface CaptureNoteReading {
  severity: CaptureNoteSeverity;
  /** Short words for a notice, so the classification does not live in the
   *  colour alone. Null for a fault: its box is unchanged and its own sentence
   *  already reads as one. */
  label: string | null;
}

export function readCaptureNote(code: string | null | undefined): CaptureNoteReading {
  const label = code ? NOTICES[code] : undefined;
  return label ? { severity: 'notice', label } : { severity: 'fault', label: null };
}
