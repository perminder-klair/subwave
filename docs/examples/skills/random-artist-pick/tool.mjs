export default async function prepareArtist(ctx, state, services, config, input) {
	const artist = await services.library.randomArtist({ minDistinctTracks: 2 });
	if (!artist) return { available: false, reason: 'No library artist has at least two distinct tracks.' };
	let research = { answer: '', results: [] };
	if (services.searchReady()) {
		try {
			const found = await services.searchWeb(`${artist.name} musician biography interview`);
			const escaped = artist.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const mentions = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
			research = {
				answer: '',
				results: (found.results || []).filter(row => mentions.test(`${row.title || ''} ${row.content || ''}`))
					.slice(0, 3).map(row => ({ title: String(row.title || ''), url: String(row.url || ''), content: String(row.content || '').slice(0, 700) })),
			};
		} catch {
			// Music can still run without web research. The DJ must not invent facts.
		}
	}
	return { available: true, subject: artist.name, data: research, music: { type: 'artist', artistId: artist.id } };
}
