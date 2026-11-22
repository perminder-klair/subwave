// What a proof of the MUSIC_LIBRARY_PATH mount means for the station. Pure: the
// telnet question and the cache are in library-mount.ts.
//
// The controller finds a file; Liquidsoap, in the broadcast container, opens it.
// The default compose files mount no library there, and a local path the mixer
// can't open is dead air on both legs of `fallback([dj_queue, auto_slot])`: a
// local hit gets no resolve probe, so nothing notices, and auto.m3u is built
// from the same paths. So only the mixer's own answer proves a mount, and
// everything else streams.

export type MountState =
  /** The mixer read a real file off the mount. The only state that plays local files. */
  | 'proven'
  /** The mixer answered that it can't read that file. */
  | 'unreadable'
  /** No answer: a telnet failure, a timeout, or a mixer older than the command. */
  | 'unknown'
  /** The controller found no audio file on the mount to ask about. */
  | 'no-sample';

export interface MountProof {
  mount: string;
  state: MountState;
  /** The file the mixer was asked about. */
  sample: string | null;
}

const STREAMS = 'Until then every track streams, so the music stays on air.';

/** The Doctor's reading of a mount that is set. */
export function libraryMountFinding(p: MountProof): { status: 'ok' | 'warn'; detail: string; hint?: string } {
  switch (p.state) {
    case 'proven':
      return { status: 'ok', detail: `the mixer reads ${p.mount}` };
    case 'unreadable':
      return {
        status: 'warn',
        detail: `MUSIC_LIBRARY_PATH is ${p.mount}, but the mixer can't read it`,
        hint: `The broadcast container opens the files, and it needs the library too. Mount it there at the same path as the controller, then restart broadcast. ${STREAMS}`,
      };
    case 'unknown':
      return {
        status: 'warn',
        detail: `could not ask the mixer whether it reads ${p.mount}`,
        hint: `The mixer did not answer, or its broadcast image predates this check. Check the mixer above, and update the broadcast image. ${STREAMS}`,
      };
    case 'no-sample':
      return {
        status: 'warn',
        detail: `no audio file found under ${p.mount} to test the mixer with`,
        hint: `Check that the library is mounted in the controller at that path. ${STREAMS}`,
      };
  }
}
