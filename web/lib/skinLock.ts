// While the station gate is deciding, or asking, the skin beneath it takes no tap, focus or key: a
// tap on the tune-in overlay would spend the listener's first gesture on a stream that answers 401.
// useStationAuth starts at 'checking' and on a station with no lock never leaves it, so only
// `required` tells a password check in flight from a public station. 'prompt' needs no `required`:
// the form stays up until it is answered, even if the lock is lifted beneath it.
export function skinLocked(required: boolean, phase: 'checking' | 'prompt' | 'ok'): boolean {
  return phase === 'prompt' || (required && phase === 'checking');
}
