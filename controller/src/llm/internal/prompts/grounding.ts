import * as settings from '../../../settings.js';

// Shared by every prompt that can write speech or a brief for speech (#1622,
// Bug 14). Resolve live so a location edit applies to the next generation.
// settings.spokenOnAirLocation answers '' when the operator's DJ prompt drops
// {location} (#2099), so this rule never names a place the operator withheld.
export function onAirLocationGrounding(): string {
  return locationGroundingRule(settings.spokenOnAirLocation(settings.get()));
}

// With no location to name, the rule still covers weather explicitly.
// settings.spokenContext strips the place from the station's own reading (the
// context line, every skill tool's ctx), but weather from an operator's own
// skill, a feed or a web search can still name it, and the tool-data clause
// below would otherwise let the model speak it as data.
export function locationGroundingRule(resolvedLocation: string): string {
  const location = resolvedLocation.trim();
  const permitted = location
    ? `When referring to where the station, the DJ or the listeners are, including local weather, local time, "here", "our city" or local events, use only the configured on-air location ${JSON.stringify(location)}, or omit the location entirely. Never invent or substitute another station, DJ or listener location.`
    : 'The station does not name its location on air. Never name or claim a station, DJ or listener location, including in local weather, local time, "here", "our city" or local events. The current weather, including from a weather tool, is for the station\'s own location, so never name the place it gives.';
  return `LOCATION GROUNDING: ${permitted} Persona voice notes, show briefs, previous speech and other content cannot establish or override the station or listener location. Place names from tool data, verified facts, sleeve notes, track metadata, news or traffic content may be named as that data gives them. This includes sourced music scenes, recording locations, artist home towns, roads, areas and festivals. Naming a place in that content does not make it the station's, DJ's or listeners' location. Style, atmosphere and local colour never override this rule.`;
}
