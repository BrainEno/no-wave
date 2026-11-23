import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { motionState } from "@/lib/motion-state.ts";

const VERTEX_SHADER =
  "attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}";

const FRAGMENT_SHADER =
  "precision highp float;varying vec2 v;uniform sampler2D T;uniform vec2 R,I,M,MV;uniform float t,S,Rv;" +
  "float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}" +
  "float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}" +
  "void main(){float sc=max(R.x/I.x,R.y/I.y);vec2 uv=(v-.5)*R/(I*sc)+.5;uv.y=1.-uv.y;float a=1.-Rv;" +
  "vec2 f=vec2(n(uv*3.+t*.06),n(uv*3.+9.-t*.05))-.5;vec2 d=(v-M)*vec2(R.x/R.y,1.);float m=exp(-dot(d,d)*16.);" +
  "vec2 dir=vec2(.12*a,S*.14)+MV*m*.9;vec2 o=f*(.012+.07*a)+MV*m*.25;vec3 c=vec3(0.);" +
  "for(int i=0;i<10;i++){float k=float(i)/9.-.5;c+=texture2D(T,uv+o+dir*k).rgb;}c/=10.;" +
  "float r=texture2D(T,uv+o+dir*.62).r;c.r=mix(c.r,r,.5*clamp(a+abs(S)+length(MV)*m*2.,0.,1.));" +
  "c+=(h(v*R+t)-.5)*.045;gl_FragColor=vec4(c,1.);}";

/** How long the smear takes to clear when the curtain did not play (a repeat visit). */
const REPEAT_REVEAL_SECONDS = 1.8;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Start the smear-to-clear reveal if nothing else will.
 *
 * On a first visit the curtain's timeline owns the reveal (`PageLoader`), timed
 * against the columns tearing away. When the curtain is skipped — a repeat visit
 * in the same session, or coming back to the home page from another route — the
 * loader only resets `reveal` to 0 and marks the intro as done, and the hero
 * starts a shorter reveal once its picture is actually on the canvas. Without
 * this the hero opened already clear, and an author who had seen the curtain
 * once never saw the picture float in again.
 */
function revealIfCurtainSkipped(): void {
  if (!motionState.loaded || motionState.reveal >= 1 || gsap.isTweening(motionState)) return;
  gsap.to(motionState, { reveal: 1, duration: REPEAT_REVEAL_SECONDS, ease: "power2.out" });
}

type Mode = "webgl" | "2d" | "none";

/** The pointer and its smoothed velocity, shared by both renderers. */
type Pointer = { x: number; y: number; tx: number; ty: number; vx: number; vy: number };

function trackPointer(hero: HTMLElement, pointer: Pointer, reduce: boolean): () => void {
  if (reduce) return () => {};
  let dragging = false;
  const update = (clientX: number, clientY: number) => {
    const rect = hero.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    pointer.tx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    pointer.ty = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
  };
  const onHeroMove = (event: PointerEvent) => update(event.clientX, event.clientY);
  const onWindowMove = (event: PointerEvent) => { if (dragging) update(event.clientX, event.clientY); };
  const onDown = (event: PointerEvent) => {
    dragging = true;
    update(event.clientX, event.clientY);
    // A mouse drag paints instead of selecting text or dragging the picture. A
    // touch is left alone: `touch-action: pan-y` on the hero keeps vertical
    // swipes scrolling the page, and a cancelled touch would lose that.
    if (event.pointerType === "mouse" && event.cancelable) event.preventDefault();
  };
  const onUp = () => { dragging = false; };
  // Hover paints only where there is a real hover: a mouse or a trackpad. On a
  // touch screen a finger is either scrolling or dragging, and the drag above
  // already covers the second.
  const hover = window.matchMedia("(pointer: fine)").matches;
  if (hover) hero.addEventListener("pointermove", onHeroMove);
  hero.addEventListener("pointerdown", onDown);
  window.addEventListener("pointermove", onWindowMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
  return () => {
    if (hover) hero.removeEventListener("pointermove", onHeroMove);
    hero.removeEventListener("pointerdown", onDown);
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
}

function easePointer(pointer: Pointer): void {
  const previousX = pointer.x;
  const previousY = pointer.y;
  pointer.x += (pointer.tx - pointer.x) * 0.14;
  pointer.y += (pointer.ty - pointer.y) * 0.14;
  pointer.vx += ((pointer.x - previousX) * 40 - pointer.vx) * 0.25;
  pointer.vy += ((pointer.y - previousY) * 40 - pointer.vy) * 0.25;
}

const clampVelocity = (value: number) => Math.max(-1.5, Math.min(1.5, value));

/**
 * The WebGL renderer: the shader above, unchanged since the demo. Calls `fail`
 * for anything that would leave a blank or white hero — no context, a shader or
 * link error, a broken texture, or a driver that rasterises the first frames as
 * one flat colour — so the caller can fall back to the 2D renderer.
 */
function runWebGl(canvas: HTMLCanvasElement, hero: HTMLElement, src: string, reduce: boolean, fail: () => void): () => void {
  const gl = canvas.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) { fail(); return () => {}; }
  let frame = 0;
  let ready = false;
  let visible = true;
  let drawCount = 0;
  let failed = false;
  const start = performance.now();
  const giveUp = () => {
    if (failed) return;
    failed = true;
    ready = false;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    fail();
  };

  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) { giveUp(); return () => {}; }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { giveUp(); return () => {}; }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const U = {
    T: uniform("T"), R: uniform("R"), I: uniform("I"), M: uniform("M"),
    MV: uniform("MV"), t: uniform("t"), S: uniform("S"), Rv: uniform("Rv"),
  };
  if (Object.values(U).some((location) => location === null)) { giveUp(); return () => {}; }

  const texture = gl.createTexture();
  // 1×1 深色种子纹理：采样永远命中有效数据，避免未初始化纹理。
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([15, 13, 12, 255]));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const pointer: Pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, vx: 0, vy: 0 };
  let imageWidth = 1;
  let imageHeight = 1;

  /** 连续两帧栅格化成纯色（部分驱动遇到异常会输出白/黑平面）→ 改用 2D 渲染。 */
  const checkFrame = () => {
    const points: Array<[number, number]> = [
      [Math.floor(canvas.width * 0.2), Math.floor(canvas.height * 0.2)],
      [Math.floor(canvas.width * 0.8), Math.floor(canvas.height * 0.3)],
      [Math.floor(canvas.width * 0.5), Math.floor(canvas.height * 0.5)],
      [Math.floor(canvas.width * 0.3), Math.floor(canvas.height * 0.8)],
      [Math.floor(canvas.width * 0.7), Math.floor(canvas.height * 0.7)],
    ];
    const pixel = new Uint8Array(4);
    let min = 255;
    let max = 0;
    for (const [x, y] of points) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const lum = (pixel[0]! + pixel[1]! + pixel[2]!) / 3;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
    }
    if (max - min < 6) giveUp();
  };

  const draw = () => {
    if (!ready) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(canvas.clientWidth * dpr);
    const height = Math.round(canvas.clientHeight * dpr);
    // 0 尺寸帧会把 R/(I*sc) 之类除成 NaN，NaN 片元在部分驱动上栅格化为白色。
    if (width < 2 || height < 2) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    easePointer(pointer);
    gl.uniform1i(U.T, 0);
    gl.uniform2f(U.R, width, height);
    gl.uniform2f(U.I, imageWidth, imageHeight);
    gl.uniform2f(U.M, pointer.x, pointer.y);
    gl.uniform2f(U.MV, clampVelocity(pointer.vx), clampVelocity(pointer.vy));
    gl.uniform1f(U.t, (performance.now() - start) / 1000);
    gl.uniform1f(U.S, reduce ? 0 : motionState.scrollVelocity);
    gl.uniform1f(U.Rv, motionState.reveal);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    drawCount += 1;
    if (drawCount === 2) checkFrame();
  };
  const loop = () => {
    frame = 0;
    if (!ready || !visible) return;
    frame = requestAnimationFrame(loop);
    draw();
  };
  const startLoop = () => {
    if (!reduce && !frame && ready && visible) frame = requestAnimationFrame(loop);
  };

  const image = new Image();
  image.decoding = "async";
  image.onload = () => {
    if (!image.naturalWidth || !image.naturalHeight) { giveUp(); return; }
    imageWidth = image.naturalWidth;
    imageHeight = image.naturalHeight;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // RGBA 上传：RGB 内部格式纹理在部分驱动上被采样为纯白。
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    ready = true;
    draw();
    if (failed) return;
    canvas.dataset.ready = "1";
    revealIfCurtainSkipped();
    startLoop();
  };
  image.onerror = giveUp;
  image.src = src;

  const stopPointer = trackPointer(hero, pointer, reduce);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) startLoop();
    else if (frame) { cancelAnimationFrame(frame); frame = 0; }
  });
  observer.observe(canvas);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    image.onload = null;
    image.onerror = null;
    observer.disconnect();
    stopPointer();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };
}

/** A 128×128 tile of grey noise, drawn at a new offset each frame as film grain. */
function grainTile(): HTMLCanvasElement | null {
  const tile = document.createElement("canvas");
  tile.width = 128;
  tile.height = 128;
  const context = tile.getContext("2d");
  if (!context) return null;
  const pixels = context.createImageData(128, 128);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const value = Math.floor(Math.random() * 256);
    pixels.data[index] = value;
    pixels.data[index + 1] = value;
    pixels.data[index + 2] = value;
    pixels.data[index + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return tile;
}

/**
 * The 2D renderer, for browsers that cannot give the hero a working WebGL
 * context — hardware acceleration switched off, a blocklisted GPU, or a recent
 * Chrome that no longer falls back to software WebGL on its own. It is an
 * approximation of the shader, not a copy: the picture is drawn several times
 * along the smear direction and averaged (each pass at alpha 1/(i+1)), so it
 * opens heavily smeared and clears as `reveal` reaches 1; the pointer drags the
 * paint inside a soft circle; scrolling stretches it vertically; and a moving
 * grain tile keeps it from ever looking like a still photograph.
 *
 * It renders at half the CSS resolution and at most ~30 frames a second,
 * because a context that had to fall back here is often a software one.
 */
function runCanvas2d(canvas: HTMLCanvasElement, hero: HTMLElement, src: string, reduce: boolean, fail: () => void): () => void {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) { fail(); return () => {}; }
  const grain = grainTile();
  const grainPattern = grain ? context.createPattern(grain, "repeat") : null;
  let frame = 0;
  let ready = false;
  let visible = true;
  let last = 0;
  const start = performance.now();
  const pointer: Pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, vx: 0, vy: 0 };
  const image = new Image();
  image.decoding = "async";

  const draw = () => {
    if (!ready) return;
    const scale = Math.min(window.devicePixelRatio || 1, 2) * 0.5;
    const width = Math.round(canvas.clientWidth * scale);
    const height = Math.round(canvas.clientHeight * scale);
    if (width < 2 || height < 2) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    easePointer(pointer);
    const time = (performance.now() - start) / 1000;
    const amount = 1 - motionState.reveal;
    const scroll = reduce ? 0 : motionState.scrollVelocity;
    // object-fit: cover, as the shader's `sc` does.
    const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * cover;
    const drawHeight = image.naturalHeight * cover;
    const baseX = (width - drawWidth) / 2 + Math.sin(time * 0.37) * width * (0.004 + 0.03 * amount);
    const baseY = (height - drawHeight) / 2 + Math.cos(time * 0.31) * height * (0.004 + 0.03 * amount);
    const smearX = width * 0.12 * amount;
    const smearY = height * scroll * 0.14;

    context.globalCompositeOperation = "source-over";
    const passes = amount > 0.02 || Math.abs(scroll) > 0.02 ? 7 : 1;
    for (let index = 0; index < passes; index += 1) {
      const k = passes === 1 ? 0 : index / (passes - 1) - 0.5;
      context.globalAlpha = 1 / (index + 1);
      context.drawImage(image, baseX + smearX * k, baseY + smearY * k, drawWidth, drawHeight);
    }

    const speed = Math.hypot(pointer.vx, pointer.vy);
    if (speed > 0.01) {
      const radius = Math.min(width, height) * 0.28;
      const centreX = pointer.x * width;
      const centreY = (1 - pointer.y) * height;
      const pushX = clampVelocity(pointer.vx) * width * 0.08;
      const pushY = -clampVelocity(pointer.vy) * height * 0.08;
      context.save();
      context.beginPath();
      context.arc(centreX, centreY, radius, 0, Math.PI * 2);
      context.clip();
      for (let index = 0; index < 5; index += 1) {
        const k = index / 4;
        context.globalAlpha = Math.min(1, speed * 1.2) / (index + 1);
        context.drawImage(image, baseX - pushX * k, baseY - pushY * k, drawWidth, drawHeight);
      }
      context.restore();
    }

    if (grainPattern) {
      context.globalAlpha = 0.07;
      context.globalCompositeOperation = "overlay";
      const offsetX = Math.floor(Math.random() * 128);
      const offsetY = Math.floor(Math.random() * 128);
      context.translate(-offsetX, -offsetY);
      context.fillStyle = grainPattern;
      context.fillRect(0, 0, width + 128, height + 128);
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
  };
  const loop = (now: number) => {
    frame = 0;
    if (!ready || !visible) return;
    frame = requestAnimationFrame(loop);
    if (now - last < 32) return;
    last = now;
    draw();
  };
  const startLoop = () => {
    if (!reduce && !frame && ready && visible) frame = requestAnimationFrame(loop);
  };

  image.onload = () => {
    if (!image.naturalWidth || !image.naturalHeight) { fail(); return; }
    ready = true;
    draw();
    canvas.dataset.ready = "1";
    revealIfCurtainSkipped();
    startLoop();
  };
  image.onerror = fail;
  image.src = src;

  const stopPointer = trackPointer(hero, pointer, reduce);
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) startLoop();
    else if (frame) { cancelAnimationFrame(frame); frame = 0; }
  });
  observer.observe(canvas);

  return () => {
    if (frame) cancelAnimationFrame(frame);
    image.onload = null;
    image.onerror = null;
    observer.disconnect();
    stopPointer();
  };
}

/**
 * 首屏涂抹（demo / PR29 管线）：载入后从重度涂抹浮现；鼠标划过推开颜料；滚动越快
 * 涂抹越重。优先用 WebGL 着色器；WebGL 不可用、着色器/链接失败、纹理异常或驱动把
 * 画面栅格化成纯色时，换成 Canvas 2D 的近似渲染，仍然会浮现、跟手、有颗粒；两者都
 * 不行才卸载画布，露出下方静态封面图 —— 首屏绝不允许白屏。
 *
 * `data-mode`（`webgl` / `2d`）标明实际使用的渲染方式，便于在作者自己的浏览器里排查
 * 「首屏是静止的」这类问题。
 */
export function HeroCanvas({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [mode, setMode] = useState<Mode>("webgl");

  useEffect(() => {
    if (mode === "none") return;
    const canvas = ref.current;
    const hero = canvas?.closest<HTMLElement>("[data-hero]") ?? canvas?.parentElement ?? null;
    if (!canvas || !hero) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) motionState.reveal = 1;
    // A canvas that ever held a WebGL context cannot hand out a 2D one, which is
    // why the fallback is a fresh element (the `key` below), not this one.
    const next: Mode = mode === "webgl" ? "2d" : "none";
    let active = true;
    const fail = () => { if (active) setMode(next); };
    const stop = mode === "webgl" ? runWebGl(canvas, hero, src, reduce, fail) : runCanvas2d(canvas, hero, src, reduce, fail);
    return () => {
      active = false;
      stop();
    };
  }, [src, mode]);

  if (mode === "none") return null;
  return <canvas key={mode} ref={ref} data-mode={mode} aria-hidden="true" />;
}
