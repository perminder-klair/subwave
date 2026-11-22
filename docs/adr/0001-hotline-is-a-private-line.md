# The Hotline is a private line

A Call is never broadcast: the Caller and the DJ talk one-to-one, and only what the Call produces (a Grant and its Dedication) reaches the air, spoken by the DJ in its own words. Airing a live caller would need a live input in `radio.liq`, on-air moderation of raw caller audio across thousands of installs, a pause-and-talk-shaped hole in the music, dead-air handling when a call drops, and a Caller hearing themselves 22 s late. A private line gives the radio feel (ring the DJ, hear your track and dedication) without any of that.

## Considered Options

- **Live on air**, a classic phone-in: rejected for the reasons above.
- **Private now, a recorded clip on air later**: the route to airing a Caller's voice if it is ever wanted. It would be an operator-approved clip placed as a segment through the slot table, never a live feed.

## Consequences

Nothing on air ever waits on a Call, so the broadcast path needs no new input and no new failure mode. The Caller pauses their own stream for the Call and rejoins at the live edge afterwards.
