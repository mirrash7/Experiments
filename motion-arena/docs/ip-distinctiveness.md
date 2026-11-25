# Hero likeness: notes for a legal read

**Status:** prepared for QA item P1-2 (`docs/qa-round4.md`). These are engineering and art notes to give a lawyer context. They are not legal advice and don't replace a review by counsel.

## What the hero was asked to be

The user supplied a reference image of a well-known, copyrighted anime character in a game-skin render, and asked the hero to "look like" it. From the start, the team's brief was an **original character in the same art style**: match the style, palette, proportions and outfit design language, not the character itself. The guardrail is written at the top of `docs/character-art-spec.md` and was checked in every QA round.

## Signature features deliberately excluded

| Feature of the reference character | Status in our hero |
|---|---|
| X-shaped scar on the chest | Not present. The chest has painted muscle lines only. |
| Small scar under the left eye | Not present. |
| Straw hat (the character's main identifier) | Not present. No headwear of any kind. |
| Character name, crew name, logos, text | None anywhere in the code, assets, UI or file names. The hero is unnamed. |
| Stretching or rubber-body abilities | None. The hero only mirrors the player's real movement. |
| Source art, models or textures | None used. Every mesh, texture and face drawing is generated in code from scratch (`web/src/hero/`). Nothing was traced from, or derived from, the reference file. |

## What is shared (style elements)

These came from the reference on purpose, as style targets:

- Lean, athletic teen build, about 6 heads tall
- Messy, spiky jet-black hair
- Big round dark eyes and a wide open grin
- Open red short-sleeved shirt with flared cuffs and gold buttons
- Yellow cloth sash tied at the hip with a long hanging tail
- Rolled-up blue shorts with white fluffy cuffs
- Bare lower legs and sandals
- Cel-shaded anime rendering with outlines

Taken one at a time, these are common anime and costume conventions. The risk is the **combination**. The QA reviewer's view, unchanged since round 1, is that the overall outfit + hair + face combination still reads as very close to the famous character, even with every signature mark removed.

## Risk summary (engineering view)

- **Internal prototyping and private testing:** low concern. Nothing copied, no names or marks.
- **Public showing, marketing or a commercial release:** a real likeness risk. Trade-dress and character-likeness arguments rest on the overall impression, not on single features. That's the question for counsel.

## Options to increase distinctiveness

Any one of these, or a few together, would move the hero further from the reference while keeping the style the user wants. Each is a contained change in the hero code. None has been made, because the user's brief is to look like the reference; this needs a decision.

1. **Signature accessory** (the reviewer's suggestion), e.g. a scarf, goggles worn on the forehead, fingerless gloves, a necklace or a wrist wrap. It gives the hero its own silhouette mark in place of the missing hat.
2. **Sash pattern or colour**: a printed or striped sash, or a different colour such as teal or orange, instead of plain yellow.
3. **Shirt change**: a different colour (for example a teal or white jacket), a hood, sleeves rolled differently, or no buttons.
4. **Hair colour or style**: a coloured streak, dark brown or dark blue hair, or a different fringe shape.
5. **Shorts**: a different colour, or no fur cuffs (for example cargo pockets or a wrapped hem instead).
6. **Face**: a different eye shape or colour, or a recurring mark of our own (a plaster on the cheek, a freckle pattern).

The rig, animation, tracking and game code don't depend on any of these looks, so changing the costume or palette later won't affect the game.
