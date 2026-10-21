// Real picker, real discovery tools, synthetic HTTP: the guard's extra search over the text index.
process.env.GENRE_STEER_TEST = 'text';
await import('./test-utils/genre-steer-suite.js');
