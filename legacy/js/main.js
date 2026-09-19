import { Game } from './game.js';

const canvas = document.getElementById('game');
const fpsEl = document.getElementById('stat-fps');

const game = new Game(canvas);

let last = performance.now();
let acc = 0;
let frames = 0;

function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  game.update(dt);
  game.render();

  acc += dt;
  frames += 1;
  if (acc >= 0.5) {
    fpsEl.textContent = `FPS ${Math.round(frames / acc)}`;
    acc = 0;
    frames = 0;
  }

  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);
