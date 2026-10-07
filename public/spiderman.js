// Easter egg: say "spiderman" in chat and a little cartoon web-slinger swings across the video.
// Self-contained so it's easy to remove: delete this file and the two lines in party.js that use it.

const TRIGGER = /spider[\s-]?man/i;

const FIGURE = `
<svg viewBox="0 0 80 110" width="80" height="110" xmlns="http://www.w3.org/2000/svg">
  <g stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M40 34 L40 4" stroke="#d81f2a" stroke-width="9"/>
    <path d="M44 44 L62 58" stroke="#d81f2a" stroke-width="9"/>
    <path d="M34 70 L18 92 L8 86" stroke="#1f4fd8" stroke-width="10" fill="none"/>
    <path d="M46 70 L60 86 L72 100" stroke="#1f4fd8" stroke-width="10" fill="none"/>
    <rect x="28" y="38" width="24" height="36" rx="10" fill="#d81f2a"/>
    <path d="M28 62 h24 v6 a10 10 0 0 1 -10 10 h-4 a10 10 0 0 1 -10 -10 z" fill="#1f4fd8"/>
    <circle cx="40" cy="28" r="15" fill="#d81f2a"/>
    <path d="M30 24 q7 1 8 9 q-8 1 -10 -5 z" fill="#fff"/>
    <path d="M50 24 q-7 1 -8 9 q8 1 10 -5 z" fill="#fff"/>
  </g>
</svg>`;

let swinging = false;

/** Call with each new chat message's text. */
export function maybeSwing(text, stage) {
  if (swinging || !TRIGGER.test(text)) return;
  swinging = true;

  const width = stage.clientWidth;
  const rope = Math.max(160, stage.clientHeight * 0.5);

  const layer = document.createElement('div');
  layer.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:4';
  // The anchor glides across the top; the rope hangs from it and swings like a pendulum.
  const anchor = document.createElement('div');
  anchor.style.cssText = 'position:absolute;top:-10px;left:0;width:0;height:0';
  const arm = document.createElement('div');
  arm.style.cssText = `position:absolute;top:0;left:-1px;width:2px;height:${rope}px;background:rgb(255 255 255 / 0.85);transform-origin:top center`;
  const figure = document.createElement('div');
  figure.style.cssText = 'position:absolute;top:100%;left:-39px;margin-top:-6px;filter:drop-shadow(0 4px 6px rgb(0 0 0 / 0.5))';
  figure.innerHTML = FIGURE;

  arm.append(figure);
  anchor.append(arm);
  layer.append(anchor);
  stage.append(layer);

  const duration = 3200;
  anchor.animate(
    [{ transform: `translateX(${-rope * 0.2}px)` }, { transform: `translateX(${width + rope * 0.2}px)` }],
    { duration, easing: 'linear' },
  );
  arm.animate(
    [{ transform: 'rotate(65deg)' }, { transform: 'rotate(-65deg)' }],
    { duration, easing: 'ease-in-out' },
  ).finished.catch(() => {}).then(() => {
    layer.remove();
    swinging = false;
  });
}
