# Rockpool

A rock pool on the shore, seen from above, rendered live in raw WebGPU and
WGSL. Blennies dart for cover and come back to inspect a still hand, hermit
crabs pull into their shells, anemones close when touched, and every so
often the sea surges in through the gully. Scroll (or swipe with two
fingers) to turn the clock and the tide.

No engine and no assets: every rock, creature and sound is generated in
code. The production bundle is about 37 KB gzipped.

## How it works

Each frame, in order:

1. **Water simulation** (compute, `src/shaders/sim.wgsl`). A 416×384 height
   field over the pool, gully and a strip of sea. Forces: the pointer drags
   a wake, taps and fish add drops, and noise adds wind ripples. A wave
   equation, with a little viscosity, runs in several substeps. Cells on the
   seaward edge follow the analytic sea, so swells and surges flow in
   through the gully. Foam and night-time plankton glow drift down the
   surface slope and fade.
2. **Caustics** (`caustics.wgsl`). A grid of sun rays is refracted through the
   surface. Brightness is the ratio of each grid patch's area before and
   after refraction, from screen-space derivatives. It is drawn three
   times, at refractive indices 1.329, 1.333 and 1.338, for a faint
   rainbow fringe.
3. **Sun shadow map.** Rock, creatures and weed.
4. **Scene** (`terrain.wgsl` plus one shader per creature). The rock is a
   displaced grid over a terrain texture that is generated once on the GPU
   (`terraingen.wgsl`). Materials come in intertidal bands: barnacles,
   mussels and green weed low down, black and orange lichen higher up, and
   pink coralline crust, gravel and sand underwater. Everything underwater
   is lit through the water: refracted sun, caustics, and depth absorption
   on the way down.
5. **Water surface** (`water.wgsl`). Each pixel finds the surface along its
   view ray and refracts into the scene behind it. The colour is absorbed
   and hazed by the depth of water crossed. It adds Fresnel reflection of
   the sky (or the rocks, found by ray-marching the height field), sun
   glints, foam, and plankton glow at night.
6. **Post.** Bloom chain, Khronos PBR Neutral tone mapping, vignette, grain.

The creatures are meshes of parameters only, shaped in their vertex shaders:

- **Fish** are a tube bent along a swimming spine.
- **Hermit crabs** are a logarithmic-spiral shell with jointed limbs that
  retract into the aperture.
- **Anemones** are a column and two rings of tentacles that sway with the
  water.
- **Sea stars** are a five-armed disc draped over the rock.

Their behaviour runs on the CPU in `src/life.ts`. Fish rest, hop, dart to
shelter, and inspect. Crabs wander, pause, retract and re-emerge. Anemones
close when touched.

Time of day blends keyframes (`src/look.ts`). The tide follows a
12.42-hour cycle: it sets the swell height and how often and how hard the
sea surges in.

## Running

```sh
npm install
npm run dev
```

Needs a browser with WebGPU (recent Chrome, Edge or Safari).

URL parameters: `?hour=18` starts at a given hour, `?seed=3` fixes the
creatures, `?clean` hides the text, and `?zoom=3&at=0.5,0.6` moves the
camera for close inspection.

## Checks

```sh
npm run dev
node scripts/check.mjs http://localhost:5173
```

Drives headless Chrome with WebGPU and checks: a fast hand scatters the
fish, a still hand draws one in, touching an anemone closes it, scrolling
turns the clock, a surge reaches the pool, and nothing logs an error.
`scripts/shoot.mjs` takes screenshots.

## Credits

The techniques are well known in real-time graphics. Caustics by area ratio
follow Evan Wallace's WebGL Water. The overall approach (a simulated surface
driving everything, procedural creatures, time-of-day looks) was inspired by
Luis Bizarro's *Koi*; no code or assets from it are used.
