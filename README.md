# Qube Way

A 3D arrow puzzle for the browser. Arrows are wrapped around all six sides of a cube.
Tap an arrow and it slides forward along its own path and off the cube, but only if
nothing is in the way. Clear every arrow to finish the level.

**Play:** https://kerembasimc.github.io/QubeWay/

## How to play
- **Tap** an arrow to launch it. It leaves over the edge of the face its head points to.
- If another arrow is in its path, it crashes and you lose a ★. Lose all 3 and the level fails.
- **Drag** to rotate the cube, **pinch / scroll** to zoom, **⟲** resets the view.
- **Hint** (20 coins) highlights an arrow that can leave safely.
- Earn coins by finishing levels (more stars = more coins) and from the daily reward.
  Out of stars? Spend 50 coins once per level to continue.
- Every 5th level is **HARD** and every 10th is **SUPER HARD** (bigger cube, longer arrows).

## Tech
- Plain HTML/CSS/JS with ES modules and no build step. Rendering uses [three.js](https://threejs.org/)
  (vendored in `lib/`).
- `puzzle.js` has the cube-surface model and a seeded level generator. Arrows are placed
  so that each new arrow's exit is clear of every arrow placed before it, which makes every
  level solvable.
- `game.js` handles rendering, input, animation, audio (Web Audio), progress and coins.
  Progress is saved in `localStorage`.
- PWA: installable, and it works offline through `service-worker.js`.

## Run locally
```bash
python -m http.server 8000
# open http://localhost:8000
```
