import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const stateDir = createTempDir(join(tmpdir(), 'subwave-request-alias-'));
process.env.STATE_DIR = stateDir;
process.env.NAVIDROME_URL = 'http://navidrome.fixture';
process.env.NAVIDROME_USER = 'fixture';
process.env.NAVIDROME_PASSWORD = 'fixture';

const settings = await import('../src/settings.js');
const identifyModule = await import('../src/llm/internal/tools/picker/tools/identify-requested-track.js');
const identifyTool = identifyModule.default;

await settings.load();

after(async () => removeTempDir(stateDir));

test('identified lyrics resolve a single artist track stored under an English alias', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const musicQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible',
        model: 'fixture-model',
        compatibleMode: 'local',
        baseUrl: 'http://llm.fixture/v1',
        fallback: { enabled: false },
      },
      search: {
        provider: 'searxng',
        baseUrl: 'http://search.fixture',
      },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

      if (url.origin === 'http://search.fixture') {
        return json({
          results: [{
            title: 'Chite Suite Te Lyrics',
            content: 'Chite suit te daag pai gaye gali teri vich gara. Chitte Suit Te by Geeta Zaildar.',
          }],
        });
      }

      if (url.origin === 'http://llm.fixture') {
        const body = JSON.parse(String(init?.body || '{}'));
        const toolName = body?.tools?.[0]?.function?.name || 'emit';
        return json({
          id: 'chatcmpl-alias',
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_alias',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    title: 'Chitte Suit Te',
                    // The web evidence contains the performer, but the
                    // identification model deliberately omits it. The tool
                    // must recover and verify that hint itself.
                    artist: null,
                    keyword: 'Chitte',
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        });
      }

      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        musicQueries.push(`${query}|${songCount}`);
        const artistOnly = query === 'Geeta Zaildar' && songCount > 0;
        const artistLookup = query === 'Geeta Zaildar' && songCount === 0;
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: artistLookup ? [{ id: 'geeta', name: 'Geeta Zaildar' }] : [],
              song: artistOnly ? [{
                id: 'white-suit',
                title: 'White Suit',
                artist: 'Geeta Zaildar',
                album: 'The Hits',
                duration: 240,
              }] : [],
            },
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({
      reference: 'chite suit te daag pai gaye gali teri vich gara',
    }, {} as any);

    assert.deepEqual(result, {
      candidates: [{
        id: 'white-suit',
        title: 'White Suit',
        artist: 'Geeta Zaildar',
        album: 'The Hits',
        duration: 240,
      }],
    });
    assert.ok(musicQueries.includes('Geeta Zaildar|25'));
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('a noisy first lyric result gets one exact-fragment retry before giving up', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const searchQueries: string[] = [];
  const musicQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible',
        model: 'fixture-model',
        compatibleMode: 'local',
        baseUrl: 'http://llm.retry.fixture/v1',
        fallback: { enabled: false },
      },
      search: {
        provider: 'searxng',
        baseUrl: 'http://search.retry.fixture',
      },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

      if (url.origin === 'http://search.retry.fixture') {
        const query = url.searchParams.get('q') || '';
        searchQueries.push(query);
        return json({
          results: query.includes('song artist')
            ? [{ title: 'Patient Zero lyrics', content: 'Patient Zero by Taylor Swift lyrics and song details.' }]
            : [{ title: 'A Shot lyrics', content: 'A Shot by Taylor Swift lyrics.' }],
        });
      }

      if (url.origin === 'http://llm.retry.fixture') {
        const body = JSON.parse(String(init?.body || '{}'));
        const prompt = JSON.stringify(body);
        const focused = prompt.includes('Patient Zero');
        const toolName = body?.tools?.[0]?.function?.name || 'emit';
        return json({
          id: 'chatcmpl-retry',
          object: 'chat.completion',
          created: 1,
          model: 'fixture-model',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_retry',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify({
                    title: focused ? 'Patient Zero' : 'A Shot',
                    artist: 'Taylor Swift',
                    keyword: focused ? 'Patient Zero' : 'A Shot',
                  }),
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        });
      }

      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        musicQueries.push(`${query}|${songCount}`);
        const patientZero = query === 'Taylor Swift Patient Zero' && songCount > 0;
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: [],
              song: patientZero ? [{
                id: 'patient-zero',
                title: 'Patient Zero',
                artist: 'Taylor Swift',
                album: 'The Life of a Showgirl: The Encore',
                duration: 225,
              }] : [],
            },
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({
      reference: 'No, it is not a bad time at all I heard somebody saying there is trouble in paradise',
    }, {} as any);

    assert.deepEqual(result, {
      candidates: [{
        id: 'patient-zero',
        title: 'Patient Zero',
        artist: 'Taylor Swift',
        album: 'The Life of a Showgirl: The Encore',
        duration: 225,
      }],
    });
    assert.equal(searchQueries.length, 2);
    assert.ok(searchQueries.some(query => query.includes('lyrics song artist')));
    assert.ok(musicQueries.includes('Taylor Swift Patient Zero|25'));
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('a canonical lyric result resolves Patient Zero without an LLM guess', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const musicQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible',
        model: 'fixture-model',
        compatibleMode: 'local',
        baseUrl: 'http://llm.patient-zero.fixture/v1',
        fallback: { enabled: false },
      },
      search: {
        provider: 'searxng',
        baseUrl: 'http://search.patient-zero.fixture',
      },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://search.patient-zero.fixture') {
        return json({ results: [{
          title: 'Taylor Swift - Patient Zero Lyrics | AZLyrics.com',
          content: 'But if you wanna party with somebody who might know about the devil on his shoulder under his halo.',
          url: 'https://www.azlyrics.com/lyrics/taylorswift/patientzero.html',
        }] });
      }
      if (url.origin === 'http://llm.patient-zero.fixture') {
        throw new Error('the canonical lyric hint should avoid the LLM identification call');
      }
      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        musicQueries.push(`${query}|${songCount}`);
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: [],
              song: query === 'Taylor Swift Patient Zero' && songCount > 0 ? [{
                id: 'patient-zero',
                title: 'Patient Zero',
                artist: 'Taylor Swift',
                album: 'The Life of a Showgirl: The Encore',
                duration: 225,
              }] : [],
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url} ${String(init?.method || 'GET')}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({
      reference: 'But if you wanna party with somebody who might know About the devil on his shoulder under his halo When the toxins take their hold, you would rather die than let it go But if you are sick of him, I got you, I was patient zero',
    }, {} as any);

    assert.deepEqual(result, {
      candidates: [{
        id: 'patient-zero',
        title: 'Patient Zero',
        artist: 'Taylor Swift',
        album: 'The Life of a Showgirl: The Encore',
        duration: 225,
      }],
    });
    assert.deepEqual(musicQueries, ['Taylor Swift Patient Zero|25']);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('a generic first lyric result earns a distinct quoted retry', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const searchQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: { model: '', provider: 'openai-compatible', fallback: { enabled: false } },
      search: { provider: 'searxng', baseUrl: 'http://search.lyric-retry.fixture' },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://search.lyric-retry.fixture') {
        const query = url.searchParams.get('q') || '';
        searchQueries.push(query);
        return json({ results: query.toLocaleLowerCase().includes('the older i get')
          ? [{ title: 'Sasha Alex Sloan - Older Lyrics', content: 'The older I get, the more that I see. Older by Sasha Alex Sloan lyrics.', url: 'https://genius.com/Sasha-alex-sloan-older-lyrics' }]
          : [{ title: 'Find My Lyrics', content: 'Search song lyrics by any word or phrase.', url: 'https://findmylyrics.example/' }] });
      }
      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        return json({ 'subsonic-response': { status: 'ok', version: '1.16.1', searchResult3: {
          artist: [],
          song: query === 'Sasha Alex Sloan Older' && songCount > 0 ? [{ id: 'older', title: 'Older', artist: 'Sasha Alex Sloan', album: 'Only Child', duration: 191 }] : [],
        } } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({
      reference: "The older I get, the more that I see My parents aren't heroes, they're just like me",
    }, {} as any);

    assert.deepEqual(result, {
      candidates: [{ id: 'older', title: 'Older', artist: 'Sasha Alex Sloan', album: 'Only Child', duration: 191 }],
    });
    assert.equal(searchQueries.length, 2);
    assert.match(searchQueries[0], /parents/iu);
    assert.match(searchQueries[1], /the older i get/iu);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('a short transliterated lyric uses a quoted companion search and resolves a library alias', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const searchQueries: string[] = [];
  const musicQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: {
        provider: 'openai-compatible',
        model: 'fixture-model',
        compatibleMode: 'local',
        baseUrl: 'http://llm.short-lyric.fixture/v1',
        fallback: { enabled: false },
      },
      search: {
        provider: 'searxng',
        baseUrl: 'http://search.short-lyric.fixture',
      },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

      if (url.origin === 'http://search.short-lyric.fixture') {
        const query = url.searchParams.get('q') || '';
        searchQueries.push(query);
        return json({
          results: query.startsWith('"chite suit te daag pe gaye"')
            ? [{
              title: 'CHITE SUIT TE DAAG PE GAYE Best Punjabi Song',
              content: 'Song credits Song: Chite Suit Te (Kannian) Artist: Geeta Zaildar Album: Nain.',
              url: 'https://www.youtube.com/watch?v=fixture',
            }]
            : [{ title: 'Unrelated result', content: 'No music credit here.', url: 'https://example.test/noise' }],
        });
      }

      if (url.origin === 'http://llm.short-lyric.fixture') {
        throw new Error('the structured credit should resolve before the LLM call');
      }

      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        musicQueries.push(`${query}|${songCount}`);
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: [],
              song: query === 'Geeta Zaildar' && songCount > 0 ? [{
                id: 'white-suit',
                title: 'White Suit',
                artist: 'Geeta Zaildar',
                album: 'The Hits',
                duration: 240,
              }] : [],
            },
          },
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({ reference: 'chite suit te daag pe gaye' }, {} as any);

    assert.deepEqual(result, {
      candidates: [{
        id: 'white-suit',
        title: 'White Suit',
        artist: 'Geeta Zaildar',
        album: 'The Hits',
        duration: 240,
      }],
    });
    assert.ok(searchQueries.some(query => query.startsWith('"chite suit te daag pe gaye"')));
    assert.ok(musicQueries.includes('Geeta Zaildar|25'));
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('an empty first lyric search gets bounded fallback queries before failing', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const searchQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: { model: '', provider: 'openai-compatible', fallback: { enabled: false } },
      search: { provider: 'searxng', baseUrl: 'http://search.empty-first.fixture' },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://search.empty-first.fixture') {
        const query = url.searchParams.get('q') || '';
        searchQueries.push(query);
        return json({
          results: query.endsWith('song lyrics')
            ? [{
              title: 'CHITE SUIT TE DAAG PE GAYE Best Punjabi Song',
              content: 'Song credits Song: Chite Suit Te (Kannian) Artist: Geeta Zaildar Album: Nain.',
              url: 'https://www.youtube.com/watch?v=fixture',
            }]
            : [],
        });
      }
      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: [],
              song: query === 'Geeta Zaildar' && songCount > 0 ? [{
                id: 'white-suit', title: 'White Suit', artist: 'Geeta Zaildar', album: 'The Hits', duration: 240,
              }] : [],
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({ reference: 'unique fallback chite suit te daag pe gaye' }, {} as any);

    assert.equal(result.candidates[0].title, 'White Suit');
    assert.ok(searchQueries.some(query => query.includes('song lyrics')), JSON.stringify(searchQueries));
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('a long lyric starts with a bounded web fragment and resolves the local track', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const searchQueries: string[] = [];
  const musicQueries: string[] = [];
  const json = (value: unknown) => Response.json(value);
  const reference = 'phull koyi vilyat wala lai geya phull koyi vilyat wala lai geya ghod da main reh geya keyariyan';

  try {
    await settings.update({
      llm: { model: '', provider: 'openai-compatible', fallback: { enabled: false } },
      search: { provider: 'searxng', baseUrl: 'http://search.long-lyric.fixture' },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://search.long-lyric.fixture') {
        const query = url.searchParams.get('q') || '';
        searchQueries.push(query);
        // The fixture represents a provider that only finds the song when the
        // request contains a bounded content-word fragment. A complete pasted
        // verse is intentionally treated as a miss.
        const bounded = query.includes('lyrics song artist') && query.length < reference.length;
        return json({
          results: bounded ? [{
            title: 'Phull Koyi Vilyat Wala Lyrics',
            content: 'Song: Phull Koyi Vilyat Wala Artist: Fictional Punjabi Singer Album: Demo.',
            url: 'https://lyrics.example.test/phull-koyi-vilyat-wala',
          }] : [],
        });
      }
      if (url.origin === 'http://navidrome.fixture') {
        const query = url.searchParams.get('query') || '';
        const songCount = Number(url.searchParams.get('songCount') || 0);
        musicQueries.push(`${query}|${songCount}`);
        const localMatch = query.includes('Fictional Punjabi Singer')
          && query.includes('Phull Koyi Vilyat Wala')
          && songCount > 0;
        return json({
          'subsonic-response': {
            status: 'ok',
            version: '1.16.1',
            searchResult3: {
              artist: [],
              song: localMatch ? [{
                id: 'phull-koyi-vilyat-wala',
                title: 'Phull Koyi Vilyat Wala',
                artist: 'Fictional Punjabi Singer',
                album: 'Demo',
                duration: 210,
              }] : [],
            },
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({ reference }, {} as any);

    assert.deepEqual(result, {
      candidates: [{
        id: 'phull-koyi-vilyat-wala',
        title: 'Phull Koyi Vilyat Wala',
        artist: 'Fictional Punjabi Singer',
        album: 'Demo',
        duration: 210,
      }],
    });
    assert.ok(
      searchQueries.some(query => query.includes('lyrics song artist') && query.length < reference.length),
      `expected an initial bounded lyric query, got ${JSON.stringify(searchQueries)}`,
    );
    assert.ok(musicQueries.includes('Fictional Punjabi Singer Phull Koyi Vilyat Wala|25'));
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});

test('an empty lyric search returns a normal no-match result without inventing a candidate', async () => {
  const originalLlm = structuredClone(settings.get().llm);
  const originalSearch = structuredClone(settings.get().search);
  const realFetch = globalThis.fetch;
  const json = (value: unknown) => Response.json(value);

  try {
    await settings.update({
      llm: { model: '', provider: 'openai-compatible', fallback: { enabled: false } },
      search: { provider: 'searxng', baseUrl: 'http://search.no-evidence.fixture' },
    } as never);

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === 'http://search.no-evidence.fixture') return json({ results: [] });
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const built: any = identifyTool.build({ collect: (songs: any[]) => songs } as any);
    const result = await built.execute({
      reference: 'a lyric description that does not exist in the web index',
    }, {} as any);

    assert.deepEqual(result, { error: 'no web result for that reference' });
    assert.equal('candidates' in result, false);
  } finally {
    globalThis.fetch = realFetch;
    await settings.update({ llm: originalLlm, search: originalSearch } as never);
  }
});
