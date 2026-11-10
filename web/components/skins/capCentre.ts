// Puts a text-less item (an icon, a lamp, an icon-only button) on the CAP centre
// of the type beside it. Use it inside an `items-baseline` row: baseline
// alignment sits such an item's bottom edge on the baseline, and this moves its
// middle up to half the cap height. `cap` is the cap height of the item's own
// font, so the item has to inherit the font of the text it sits beside.
//
// `items-center` can't do this. It centres the text's line box, whose middle
// sits below the capitals by 1–2px, and by a different amount in each theme's
// font, so a centred icon read low in some themes and level in others.
export const CAP_CENTRE = 'translate-y-[calc(50%-0.5cap)]';

// The same for a 16px icon or icon button, which stands taller than a small line
// of text: on a shared baseline it would grow the row's box and shift the row
// against whatever it is centred with. The negative margins take it out of the
// row's height; its baseline still comes from its border box, so it lands in the
// same place.
export const CAP_CENTRE_16 = 'translate-y-[calc(50%-0.5cap)] -my-2';
