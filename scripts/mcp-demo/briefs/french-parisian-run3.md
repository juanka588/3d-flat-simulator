Run 3 - French Parisian, modern proportions. This is a 2010s French residential flat (Blanc Nature, Charme 3205): flat white ceiling at exactly 2.5 m, standard-height windows, smooth walls. It is a Parisian apartment in spirit (warm ivory, oak, brass, velvet, linen), NOT a Haussmann one.

Rules for every room
- No cornice, no ceiling rose, no crown moulding (do not use corniceMm): the reference images show a plain ceiling edge. Wall mouldings only as a few slim panel frames at chest height, tone on tone, in the rooms where they help.
- Elegant wall-colour contrast, room by room, from the style palette: warm ivory or off-white (#efe9dd) as the base, one deep accent wall where a room has a clear focal wall (bottle green #2f3b36), warm greige (#d8d0c0) or sage as the soft alternative. Paint per wall side (room_set_wall_finish with roomId), never the ceiling. The kitchen keeps its concrete-grey fronts and light-grey tiles, so the neighbouring walls are warm and light.
- Real products only (search_products / get_product, French queries). The only things that may be concepts are the labelled stand-ins: parametric generators for pieces that do not exist in a shop (slat panel, cat wall, cat tree), always labelled "concept, not for sale".
- Brass, oak and linen repeat from room to room; no chrome, no neon, no heavy dark furniture.
- Keep every locked fitting, door swing and 0.9 m walkway clear (validate_layout must be ok).
- Bed frames are drawn with a mattress that is not bought: say that mattresses are extra.

Exclude: curtain
No curtains and no drapes anywhere, at no window and no balcony door (place_item refuses them).

## sejour:living
The TV is not a fixed fitting: tv-sejour may be moved (item_move, item_rotate) to the media wall the layout intent proposes (a wall without openings, at least 2 m long, never the balcony glazing). Wooden slat TV wall: oak acoustic slat panels behind the TV, floor to ceiling (2.5 m) on the media wall wherever the TV ends up, about 2.4 to 3 m wide and centred on the TV, on black felt. No shop sells this, so it is a labelled concept: place_item with concept true, generator "slatPanel" (params: w 2.4 to 3.0, h 2.5, wood "oak", slat 0.028, gap 0.018, felt true), relation against_wall on the media wall, and keep the TV in front of it (if the solver refuses the TV overlapping the panel, use two panels either side of the TV, or a framed section of about 1.6 x 1.4 m behind it). Add a low TV unit in oak or white under it.
Wall colours: the slat wall is the warm focus, so the contrast is one deep accent wall (bottle green #2f3b36) on the sofa wall opposite the media wall, and warm off-white (#efe9dd) on the other walls. That pairs with the kitchen's concrete-grey fronts without clashing.
Furniture: a velvet or boucle sofa facing the TV, round marble-look coffee table on a pale wool rug, one caned armchair, a brass floor lamp, a tall mirror. No curtains. Keep the way to the balcony doors clear.

## sejour:kitchen
MUST use the island product given in the mandatory products below (a black LED bar table, 1.2 x 0.8 m closed, extends to 1.8 m, bar top rotating 360 degrees, storage). Place it parallel to the kitchen run, centred on the worktop, with at least 1.0 m between its edge and the run fronts, and stools on its long side (bar stools from the catalogue: two or three, black or oak, seat height 63 to 66 cm). The product has no 3D model: the viewer draws the island stand-in at its listed size, black with an LED strip under the top.
Keep the dark concrete-grey fronts, the light-grey tiles and every locked fitting. Add a brass pendant or two over the island, a tray with a carafe, a few jars, a plant. Walls: warm off-white with a soft greige splash, no strong colour next to the grey fronts.

## sdb
Keep every locked fitting, the bath screen included (locked, stays where it is), the tiles, the vanity, the mirror and the washing machine. No window: the room is lit by the lamps, so add layered light (a mirror light, a warm wall light) at 2700 K. Add: white and sage towels on the rail, a bath mat, a wooden stool, a framed print, a plant, brass-look accessories. Accent: sage or warm greige on the free wall above the tiles, ivory elsewhere.

## wc
Keep the toilet and the hand basin, which is fixed (locked) on the east wall to the RIGHT of the toilet as seen from the door; do not move it. Add a small mirror cabinet ("armoire de toilette avec miroir", 40 to 60 cm wide) on the wall above the toilet. Real IKEA options in the local catalogue: NYSJOEN / NYSJÖN Meuble avec miroir blanc 50x60 cm (ikea-fr:10470830, 49 EUR, first choice), IVÖSJÖN Meuble à miroir 1 porte 44x15x59 cm (ikea-fr:10569096, 19 EUR), FAXÄLVEN Meuble à miroir éclairage intégré 60x15x95 cm (ikea-fr:09516711, lit, taller). Hang it centred above the toilet at 1.3 to 1.9 m. No window: lamps only (one warm wall light or the ceiling spot), a small framed print, one brass hook, a plant or a candle. Walls: a deep accent (bottle green or deep sage) on the toilet wall with ivory elsewhere is welcome in this tiny room.

## ch1
MUST use the bed given in the mandatory products below: IKEA MANDAL, "Structure lit avec tête de lit" 160x200 cm, birch/white, a wooden headboard with built-in bedside shelves (2.4 m wide in all, 2.06 m deep). It replaces separate bedside tables: do NOT add nightstands. Put its headboard on the long plain east wall (w-east), clear of the wardrobe fronts, the door swing and the radiator, with a pale rug, bedding in white and linen, a lamp on each built-in shelf, a reading chair or a bench at the foot if it fits. Walls: warm greige or sage on the headboard wall, ivory elsewhere.

## alcove
Keep the gaming-desk concept: the gaming desk with two screens beside the window (never facing the window), the gaming chair, shelves with a light strip above the desk, and the cat climbing wall and the cat tree (generators catWall and catTree, labelled concepts). The run may refine the layout and the wall colours: a deep charcoal-green wall behind the desk with a warm LED strip works for a gaming room; keep the cat wall on a wall without a window and the radiator clear.

## balcon
Outdoor scene, not an indoor room: a compact bistro set (round table and two chairs, folding or outdoor), planters along the rail with herbs and grasses, a string of warm festoon lights and an outdoor lantern. The floor is artificial grass (keep it). Keep the landing in front of both french doors clear (0.9 m). Outdoor products only.

## ch2
A flexible guest, child or study room: a bed against the long plain wall (w-ch2-ch1) and a desk under or near the window (win-ch2), with the radiator and the grey sliding placard (placard-ch2) left free. Keep it light and symmetrical: a single bed or a 140 cm bed, a desk with a chair, a reading lamp, a rug. Walls: sage or soft greige on the bed wall, ivory elsewhere.

## entree
A narrow hall that must stay a walkway of at least 0.9 m: slim shoe storage (25 to 35 cm deep), a console or bench, a round or tall mirror above it, brass coat hooks or a slim coat rack, a small tray for keys. Keep every door swing and the front of the grey wardrobe placard-ch2 and the electrical panel clear. Walls: warm greige with ivory above, a few slim panel frames at chest height.
