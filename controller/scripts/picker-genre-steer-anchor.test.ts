// Real picker, real discovery tools, synthetic HTTP: the guard's extra search is seeded from the held queue head.
process.env.GENRE_STEER_TEST = 'anchor';
await import('./test-utils/genre-steer-suite.js');
